import AppKit
import CoreLocation
import Foundation
import Intents
import Vision
import WeatherKit

/// One JSON object on stdin, one JSON object on stdout. The parent process owns the paths.
/// This program does not ask for Full Disk Access.

private let folders = ["desktop": "Desktop", "documents": "Documents", "downloads": "Downloads"]

private func emit(_ value: [String: Any]) -> Never {
  let data = try! JSONSerialization.data(withJSONObject: value)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
  exit(0)
}

private func fail(_ code: String) -> Never {
  emit(["ok": false, "code": code])
}

/// The process is an agent (`LSUIElement`). Core Location and Focus ignore a request while it is inactive.
private func activateForPrompt() {
  let application = NSApplication.shared
  application.setActivationPolicy(.accessory)
  application.activate(ignoringOtherApps: true)
}

private func homeFolder(_ key: String) -> URL? {
  guard let name = folders[key] else { return nil }
  return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(name, isDirectory: true)
}

private func bookmarkFile(directory: String, folder: String) -> URL {
  URL(fileURLWithPath: directory, isDirectory: true).appendingPathComponent(folder)
}

private func readStandardInput() -> [String: Any] {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  guard
    let object = try? JSONSerialization.jsonObject(with: data),
    let record = object as? [String: Any]
  else { fail("failed") }
  return record
}

private final class LocationReader: NSObject, CLLocationManagerDelegate {
  private let manager = CLLocationManager()
  private var reading: CLLocation?
  private var code: String?

  func read() -> CLLocation {
    let status = manager.authorizationStatus
    if status == .denied || status == .restricted { fail("denied") }
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    if status == .notDetermined {
      // The request runs on the next loop turn, after activation. A request while inactive does nothing.
      activateForPrompt()
      DispatchQueue.main.async {
        self.manager.requestWhenInUseAuthorization()
      }
    } else {
      manager.requestLocation()
    }
    CFRunLoopRun()
    if let code { fail(code) }
    guard let reading else { fail("timeout") }
    return reading
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    switch manager.authorizationStatus {
    case .authorizedAlways:
      manager.requestLocation()
    case .denied, .restricted:
      code = "denied"
      CFRunLoopStop(CFRunLoopGetMain())
    case .notDetermined:
      break
    @unknown default:
      code = "failed"
      CFRunLoopStop(CFRunLoopGetMain())
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    reading = locations.last
    CFRunLoopStop(CFRunLoopGetMain())
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    let locationError = error as? CLError
    code = locationError?.code == .denied ? "denied" : "failed"
    CFRunLoopStop(CFRunLoopGetMain())
  }
}

private func locationRecord(_ location: CLLocation) -> [String: Any] {
  [
    "latitude": location.coordinate.latitude,
    "longitude": location.coordinate.longitude,
    "horizontalAccuracyMeters": location.horizontalAccuracy,
    "timestamp": ISO8601DateFormatter().string(from: location.timestamp),
  ]
}

private func readLocation() -> [String: Any] {
  let reader = LocationReader()
  let location = reader.read()
  guard location.horizontalAccuracy >= 0 else { fail("failed") }
  return locationRecord(location)
}

private func readWeather(_ location: CLLocation) async -> [String: Any] {
  do {
    let weather = try await WeatherService.shared.weather(for: location)
    let current = weather.currentWeather
    let daily = weather.dailyForecast.forecast.prefix(8).map { day -> [String: Any] in
      [
        "date": ISO8601DateFormatter().string(from: day.date),
        "condition": day.condition.description,
        "highCelsius": day.highTemperature.converted(to: .celsius).value,
        "lowCelsius": day.lowTemperature.converted(to: .celsius).value,
        "precipitationChance": day.precipitationChance,
      ]
    }
    return [
      "attribution": "Apple Weather",
      "location": locationRecord(location),
      "current": [
        "condition": current.condition.description,
        "temperatureCelsius": current.temperature.converted(to: .celsius).value,
      ],
      "daily": daily,
    ]
  } catch {
    fail("weatherkit_unavailable")
  }
}

private func sameOrInside(_ selected: URL, folder: URL) -> Bool {
  let left = selected.standardizedFileURL.path
  let right = folder.standardizedFileURL.path
  return left == right || left.hasPrefix(right.hasSuffix("/") ? right : right + "/")
}

private func allowFolder(_ key: String, prompt: String, button: String, directory: String) {
  guard let folder = homeFolder(key) else { fail("failed") }
  activateForPrompt()
  let panel = NSOpenPanel()
  panel.canChooseFiles = false
  panel.canChooseDirectories = true
  panel.canCreateDirectories = false
  panel.allowsMultipleSelection = false
  panel.directoryURL = folder
  panel.message = prompt
  panel.prompt = button
  guard panel.runModal() == .OK, let selected = panel.url else { fail("denied") }
  guard sameOrInside(selected, folder: folder) else { fail("folder_mismatch") }
  do {
    let data = try selected.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
    let file = bookmarkFile(directory: directory, folder: key)
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: file, options: .atomic)
    // The bookmark file keeps the path. The tool result does not.
    emit(["ok": true, "result": ["folder": key]])
  } catch {
    fail("failed")
  }
}

private func resolveBookmark(_ key: String, directory: String) -> URL {
  let file = bookmarkFile(directory: directory, folder: key)
  guard let data = try? Data(contentsOf: file) else { fail("bookmark_missing") }
  var stale = false
  guard
    let url = try? URL(
      resolvingBookmarkData: data,
      options: [.withSecurityScope],
      relativeTo: nil,
      bookmarkDataIsStale: &stale
    )
  else { fail("bookmark_missing") }
  guard url.startAccessingSecurityScopedResource() else { fail("denied") }
  return url
}

private func searchFolder(_ key: String, query: String, directory: String) {
  guard folders[key] != nil else { fail("failed") }
  let url = resolveBookmark(key, directory: directory)
  defer { url.stopAccessingSecurityScopedResource() }
  let metadata = NSMetadataQuery()
  metadata.searchScopes = [url]
  metadata.predicate = NSPredicate(format: "%K CONTAINS[cd] %@", NSMetadataItemDisplayNameKey, query)
  guard metadata.start() else { fail("failed") }
  RunLoop.main.run(until: Date(timeIntervalSinceNow: 8))
  metadata.stop()
  metadata.disableUpdates()
  let root = url.standardizedFileURL.path
  var files: [[String: String]] = []
  for item in metadata.results.prefix(25) {
    guard
      let value = item as? NSMetadataItem,
      let path = value.value(forAttribute: NSMetadataItemPathKey) as? String
    else { continue }
    let standard = URL(fileURLWithPath: path).standardizedFileURL.path
    guard standard == root || standard.hasPrefix(root + "/") else { continue }
    let name = value.value(forAttribute: NSMetadataItemDisplayNameKey) as? String
      ?? URL(fileURLWithPath: path).lastPathComponent
    files.append(["name": name])
  }
  emit(["ok": true, "result": ["folder": key, "query": query, "files": files]])
}

private func listApps() {
  let workspace = NSWorkspace.shared
  let front = workspace.frontmostApplication
  let running = workspace.runningApplications.compactMap { app -> [String: Any]? in
    guard app.activationPolicy != .prohibited else { return nil }
    return [
      "name": app.localizedName ?? "",
      "bundleId": app.bundleIdentifier ?? "",
      "processId": app.processIdentifier,
      "frontmost": app.processIdentifier == front?.processIdentifier,
    ]
  }
  let frontRecord: [String: Any]? = front.map {
    [
      "name": $0.localizedName ?? "",
      "bundleId": $0.bundleIdentifier ?? "",
      "processId": $0.processIdentifier,
    ]
  }
  emit(["ok": true, "result": ["frontmost": frontRecord as Any, "running": running]])
}

private func recognizeText(_ path: String) {
  let url = URL(fileURLWithPath: path)
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  let handler = VNImageRequestHandler(url: url)
  do {
    try handler.perform([request])
  } catch {
    fail("failed")
  }
  let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
  emit(["ok": true, "result": ["text": lines.joined(separator: "\n")]])
}

private func emitFocused(_ focused: Bool?) -> Never {
  guard let focused else { fail("failed") }
  emit(["ok": true, "result": ["focused": focused]])
}

private func readFocus() {
  let center = INFocusStatusCenter.default
  switch center.authorizationStatus {
  case .denied, .restricted:
    fail("denied")
  case .authorized:
    emitFocused(center.focusStatus.isFocused)
  case .notDetermined:
    activateForPrompt()
    center.requestAuthorization { status in
      DispatchQueue.main.async {
        switch status {
        case .authorized:
          emitFocused(center.focusStatus.isFocused)
        case .denied, .restricted, .notDetermined:
          fail("denied")
        @unknown default:
          fail("failed")
        }
      }
    }
    CFRunLoopRun()
    fail("failed")
  @unknown default:
    fail("failed")
  }
}

let input = readStandardInput()
guard let command = input["command"] as? String else { fail("failed") }
switch command {
case "location":
  emit(["ok": true, "result": readLocation()])
case "weather":
  let reader = LocationReader()
  let location = reader.read()
  guard location.horizontalAccuracy >= 0 else { fail("failed") }
  var result: [String: Any]?
  Task {
    result = await readWeather(location)
    CFRunLoopStop(CFRunLoopGetMain())
  }
  CFRunLoopRun()
  guard let result else { fail("timeout") }
  emit(["ok": true, "result": result])
case "allowFolder":
  guard
    let folder = input["folder"] as? String,
    let prompt = input["prompt"] as? String,
    let button = input["button"] as? String,
    let directory = input["bookmarkDirectory"] as? String
  else { fail("failed") }
  allowFolder(folder, prompt: prompt, button: button, directory: directory)
case "spotlight":
  guard
    let folder = input["folder"] as? String,
    let query = input["query"] as? String,
    let directory = input["bookmarkDirectory"] as? String
  else { fail("failed") }
  searchFolder(folder, query: query, directory: directory)
case "apps":
  listApps()
case "recognizeText":
  guard let path = input["path"] as? String else { fail("failed") }
  recognizeText(path)
case "focus":
  readFocus()
default:
  fail("failed")
}

import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/agent";

export const messages = {
  "status.agent.dryRunPreview":
    "드라이런, 아직 실행하지 않았어요: {action} ({tool}). 인수: {summary}. 실행하기 전에 OpenBot에서 사람이 승인해야 해요.",
  "status.agent.dryRunPostMessage": "외부 채팅에 메시지 게시",
  "status.agent.dryRunForgetExternalMemory": "외부 채팅의 메모리 삭제",
  "status.agent.dryRunForgetMemory": "에이전트 메모리 삭제",
  "status.agent.dryRunUninstallSkill": "스킬 제거",
  "status.agent.dryRunDeleteRoutine": "루틴 삭제",
  "status.agent.dryRunNoArguments": "없음",
  "status.agent.dryRunArgument": "{name}: {value}",
  "status.agent.dryRunTextValue": { one: "텍스트, {count}자", other: "텍스트, {count}자" },
  "status.agent.dryRunListValue": { one: "목록, {count}개", other: "목록, {count}개" },
  "status.agent.instructionsRollbackPreview":
    "{file}을(를) 보관된 텍스트 {sha256}(으)로 되돌려요. 아직 적용하지 않았어요. OpenBot에서 사람이 승인해야 해요. 추가된 줄: {added}, 삭제된 줄: {removed}. 바뀐 줄:",
  "status.agent.instructionsRollbackRemove":
    "{file}을(를) 삭제해서 만들기 전처럼 파일이 없는 상태로 되돌려요. 아직 적용하지 않았어요. OpenBot에서 사람이 승인해야 해요.",
  "status.agent.selfImproveInstructionsPreview":
    "{file} 변경, 아직 적용하지 않았어요. 이 차이는 OpenBot에서 사람이 승인해야 해요. 최근 턴에서 실패한 턴이 늘지 않은 경우에만 적용돼요. 바뀐 줄:",
  "status.agent.selfImproveSkillPreview":
    "완료한 작업에서 만든 새 스킬 {name}, 아직 설치하지 않았어요. OpenBot에서 사람이 승인해야 해요. 승인 후, 최근 턴에서 실패한 턴이 늘지 않은 경우에만 이 에이전트에 설치돼요. 파일: {files}.",
  "status.agent.dryRunObjectValue": { one: "객체, {count}개 필드", other: "객체, {count}개 필드" },
  "status.agent.dryRunEmptyValue": "비어 있음",
  "status.agent.dryRunOtherValue": "값",
  "status.agent.claudeWriteOutside": "에이전트의 워크스페이스, 공유 폴더, 임시 폴더 밖에 있는 {path}에 써요.",
  "status.agent.contextCleared": "컨텍스트를 지웠어요. 여기서 새 채팅이 시작돼요.",
  "status.agent.instructionsChanged": "지침을 업데이트했어요",
  "status.agent.modelSwitchedForLimit": "사용 한도에 도달했어요. {model}(으)로 전환했어요.",
  "status.agent.modelReturnedAfterLimit": "사용 한도가 끝났어요. {model}(으)로 다시 전환했어요.",
  "status.agent.modelSwitchedForError": "제공자 오류가 발생했어요. {model}(으)로 전환했어요.",
  "status.agent.modelReturnedAfterError": "제공자 오류 후 {model}(으)로 다시 전환했어요.",
  "status.agent.marketplaceSuggested": "마켓플레이스 앱을 추천했어요: {app}.",
  "status.agent.channelMemberAdded": "{agent} 에이전트가 {member} 멤버를 채널에 추가했어요. {person} 님이 요청했어요.",
  "status.agent.channelMemberRemoved":
    "{agent} 에이전트가 {member} 멤버를 채널에서 제거했어요. {person} 님이 요청했어요.",
  "status.agent.channelInstructionsChanged": "{agent} 에이전트가 채널 지침을 변경했어요. {person} 님이 요청했어요.",
  "status.agent.channelRoutineCreated": "{agent} 에이전트가 루틴 {routine}을(를) 만들었어요. {person} 님이 요청했어요.",
  "status.agent.channelRoutineUpdated": "{agent} 에이전트가 루틴 {routine}을(를) 변경했어요. {person} 님이 요청했어요.",
  "status.agent.channelRoutineDeleted": "{agent} 에이전트가 루틴 {routine}을(를) 삭제했어요. {person} 님이 요청했어요.",
  "status.agent.channelTaskCancelled":
    "{agent} 에이전트가 작업 “{task}”과(와) 하위 작업을 취소했어요. {person} 님이 요청했어요.",
  "status.agent.screenCaptureScreen": "메인 화면을 캡처해서 이미지를 에이전트의 모델에 보내요.",
  "status.agent.screenCaptureChannel":
    "이미지가 {channel} 채널에 표시되고, 이 채널을 읽는 서버의 모든 멤버가 볼 수 있어요.",
  "status.agent.screenCaptureDisplay": "디스플레이 {name}을(를) 캡처해서 이미지를 에이전트의 모델에 보내요.",
  "status.agent.screenCaptureWindow": "창 {name}을(를) 캡처해서 이미지를 에이전트의 모델에 보내요.",
  "status.agent.screenCaptureRegion":
    "화면의 {x}, {y} 위치에서 {width} × {height} 포인트 영역을 캡처해서 이미지를 에이전트의 모델에 보내요.",
  "status.agent.workflowDelete":
    "워크플로 {title}을(를) 실행 기록 및 버전과 함께 삭제합니다. 진행 중인 단계는 중지됩니다.",
  "status.agent.screenCaptureProgress": "화면 캡처를 요청하는 중…",
  "status.agent.screenCaptureReviewing": "화면 캡처를 확인하는 중…",
  "status.agent.browserOpening": "웹 페이지를 여는 중…",
  "status.agent.browserReading": "웹 페이지를 읽는 중…",
  "status.agent.browserClicking": "웹 페이지를 클릭하는 중…",
  "status.agent.browserTyping": "웹 페이지에 입력하는 중…",
  "status.agent.browserActing": "웹 페이지를 사용하는 중…",
  "status.agent.browserReviewing": "웹 페이지를 확인하는 중…",
  "status.agent.memoriesSearching": "메모리를 검색하는 중…",
  "status.agent.memoriesSearched": {
    other: "메모리를 검색했어요: {count}개 찾음",
  },
  "status.agent.memoriesUpdating": "메모리를 업데이트하는 중…",
  "status.agent.skillUsing": "스킬 {name}을(를) 사용하는 중…",
  "status.agent.skillReading": "스킬을 읽는 중…",
  "status.agent.toolStepFailed": "도구 단계가 실패했습니다. 결과를 확인하고 다음에 시도할 작업을 결정하는 중…",
  "status.agent.toolResultReviewing": "최신 도구 결과를 확인하는 중…",
  "status.agent.sourcesSearching": "최신 정보를 검색하는 중…",
  "status.agent.sourcesReviewing": "찾은 출처와 정보를 확인하는 중…",
  "status.agent.informationGathering": "관련 정보를 수집하는 중…",
  "status.agent.informationReviewing": "수집한 정보를 확인하는 중…",
  "status.agent.workChecking": "작업을 확인하는 중…",
  "status.agent.workReviewing": "검증 결과를 확인하는 중…",
  "status.agent.changesMaking": "요청된 변경 사항을 적용하는 중…",
  "status.agent.changesReviewing": "적용한 변경 사항을 확인하는 중…",
  "status.agent.agentCoordinating": "다른 에이전트와 조정하는 중…",
  "status.agent.agentResponseReviewing": "다른 에이전트의 응답을 확인하는 중…",
  "status.agent.toolStepWorking": "다음 도구 단계를 처리하는 중…",
  "status.agent.memoryChanges": "메모리: {saved}개 저장, {updated}개 업데이트, {forgotten}개 삭제.",
  "status.agent.memoryChangesWithConflicts":
    "메모리: {saved}개 저장, {updated}개 업데이트, {forgotten}개 삭제, {notChanged}개는 다른 스레드가 먼저 변경해서 변경 안 됨.",
  "status.agent.mcpServerAdd":
    "MCP 서버 {name}을(를) 추가해요: {target}. 이 서버의 모든 에이전트가 해당 도구를 사용할 수 있어요. OpenBot이 연결을 테스트해요.",
  "status.agent.mcpServerChange":
    "MCP 서버 {name}을(를) {target}(으)로 변경해요. 이 서버의 모든 에이전트가 해당 도구를 사용할 수 있어요. OpenBot이 연결을 테스트해요.",
  "status.agent.mcpServerEnable": "이 서버의 모든 에이전트에 MCP 서버 {name}을(를) 켜요.",
  "status.agent.mcpServerDisable": "이 서버의 모든 에이전트에 MCP 서버 {name}을(를) 꺼요.",
  "status.agent.mcpServerRemove": "이 서버의 모든 에이전트에서 MCP 서버 {name}과(와) 로그인 정보를 제거해요.",
  "status.agent.mcpSignInRequested": "MCP 서버 {name}에 로그인이 필요해요. 서버 설정의 MCP에서 로그인해 주세요.",
  "status.agent.nextStepContinues": "에이전트가 다음 단계 전에 멈췄어요. 계속해요 ({current}/{limit}).",
  "status.agent.planContinues": "계획에 남은 단계가 있어요. 에이전트가 계속해요 ({current}/{limit}).",
  "status.agent.crossCheckUnconfirmed":
    "OpenBot 교차 확인: 이 답변이 확실하지 않아요. 두 번째 제공자가 확인하지 못했어요. 확인되지 않은 점:",
  "status.agent.branchTitle": "분기된 채팅",
} as const satisfies PartialTranslation<typeof source>;

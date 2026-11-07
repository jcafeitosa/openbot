# App Brief — Correção de posição do Dynamic Island no macOS

## Nome do app/projeto
GabrielOS (OpenBot Desktop)

## Problema
O desktop app Electron no macOS cria sua própria janela de "Dynamic Island" (`type: "panel"`, `alwaysOnTop`, `status`) que é desenhada sobre o Dynamic Island nativo do macOS (o notch físico da câmera do MacBook). Há dois islands ocupando a mesma região da tela, mas sem alinhamento correto com o notch do macOS.

## Escopo da correção
1. Corrigir o cálculo de posição (`dynamicIslandWindowBounds`) para alinhar com o notch físico do MacBook
2. Ajustar o tamanho da janela da ilha para corresponder ao tamanho do notch nativo
3. Garantir que apenas uma ilha seja exibida por display (não duplicar)
4. Manter compatibilidade com displays externos (modo "island" sem notch físico)

## Arquivos principais envolvidos
- `src/main/dynamic-island-window.ts` — cálculo de bounds e posição da ilha
- `src/main/main-window.ts` — criação da janela `createDynamicIslandWindow` e carregamento do renderer
- `src/renderer/src/features/dynamic-island/DynamicIslandSurface.tsx` — renderer da ilha
- `packages/ui/src/dynamic-island.tsx` — componente compartilhado da ilha
- `packages/ui/src/features/dynamic-island/OpenBotDynamicIsland.tsx` — renderização visual

## Critérios de aceitação
- [ ] A ilha do app fica posicionada exatamente sobre o notch nativo do macOS
- [ ] Não há duas ilhas sobrepostas no mesmo display
- [ ] Displays externos continuam recebendo a ilha no modo "island"
- [ ] Configurações de tamanho (width/height percent) funcionam corretamente
- [ ] Não quebra a preferência do usuário para ilhas em displays adicionais

## Decisões técnicas pendentes
- Se a janela da ilha deve ter o mesmo tamanho físico do notch ou maior (para comportamento hover)
- Como detectar dinamicamente a posição exata do notch no macOS (vs aproximação por aspect ratio)

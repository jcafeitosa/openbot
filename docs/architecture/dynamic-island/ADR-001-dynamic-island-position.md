# ADR-001: Correção de posição do Dynamic Island no macOS

## Status
Proposta

## Contexto
O desktop app Electron no macOS cria uma janela de "Dynamic Island" que é desenhada na região do notch do MacBook. Atualmente:
1. A posição Y é sempre `display.bounds.y` (topo do display), sem considerar a posição real do notch
2. O tamanho da janela é fixo em 614x380 pixels, muito maior que o notch físico (~185x32px)
3. Não há alinhamento com o Dynamic Island nativo do macOS, resultando em dois islands sobrepostos

## Decisão
Modificar o cálculo de `dynamicIslandWindowBounds()` para posicionar a janela no topo central do display, alinhado com onde o notch fica fisicamente, usando o `notchSize` calculado para definir o tamanho mínimo da janela em estado idle.

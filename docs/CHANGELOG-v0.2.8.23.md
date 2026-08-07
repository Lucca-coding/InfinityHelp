# Changelog — InfinityHelp v0.2.8.23 BETA

## Interface

- Remove as setas de natureza dos cards de IV/status.
- O atributo aumentado pela natureza recebe o card inteiro em verde.
- O atributo reduzido pela natureza recebe o card inteiro em vermelho.

## Otimização

- Cache curto para leituras repetidas do DOM em batalha.
- Menos varreduras duplicadas para detectar golpes e Pokémon ativo.
- MutationObserver ativo somente durante batalhas e ignorando alterações do próprio painel.
- Polling adaptativo: mais espaçado no mobile.
- Leituras de storage/globais menos frequentes e pausadas com a aba oculta.
- Cache de chaves globais por 30 segundos.
- Perfil visual mobile sem blur pesado, animações decorativas contínuas e sombras grandes.

## Preservado

Todos os recursos da v0.2.8.21 BETA foram mantidos: itens, TMs/HMs, previsão de KO, barras de boss, captura, shiny, alertas de evento, time real, golpes e HP ao vivo.

## Status

BETA DE TESTE. A versão estável continua sendo a v0.2.6.1.

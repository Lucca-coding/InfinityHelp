# InfinityHelp v0.2.8.23 — BETA DE TESTE

Código-fonte público para revisão técnica e transparência. Esta versão é a mesma base da extensão BETA distribuída para testes.

A extensão trabalha com dados já carregados pelo Infinity MMO e não inclui bot, macro ou automação de ações do jogador.

## Alterações desta beta

- Natureza: o atributo aumentado agora fica com o cartão inteiro verde.
- Natureza: o atributo reduzido agora fica com o cartão inteiro vermelho.
- As setas de natureza foram removidas.
- Cache curto para leituras repetidas do DOM durante batalhas.
- Sincronização visual do Pokémon ativo foi limitada para evitar varreduras duplicadas.
- MutationObserver agora fica ativo somente durante batalhas e ignora mudanças do próprio painel.
- Polling de batalha reduzido e adaptado para dispositivos móveis.
- Varredura de localStorage/sessionStorage/globais ficou menos frequente e pausa com a aba oculta.
- Chaves globais do jogo são armazenadas em cache por 30 segundos.
- No mobile, blur, sombras pesadas e animações decorativas são reduzidos/desativados.
- Nenhum recurso de batalha, captura, itens, TMs/HMs, shiny ou eventos foi removido.

Versão BETA DE TESTE criada sobre a v0.2.8.21, preservando todos os recursos existentes.

## Base completa de itens

- 154 itens únicos da InfinityWiki reconhecidos;
- 64 itens com mecânica estruturada;
- 52 itens relevantes para a previsão de KO;
- 45 itens capazes de alterar o dano do atacante;
- 8 itens capazes de alterar defesa, precisão ou sobrevivência do alvo;
- 90 itens reconhecidos que não alteram o dano imediato.

## Efeitos aplicados ao dano

A previsão agora lê `heldItem` nos dados já entregues pelo jogo e aplica:

- itens de tipo em ×1,2;
- Gems em ×1,5 enquanto ainda estiverem equipadas;
- Expert Belt em ×1,2 somente em golpes super efetivos;
- Life Orb em ×1,3;
- Muscle Band e Wise Glasses em ×1,1;
- Choice Band e Choice Specs em ×1,5 no atributo correspondente;
- Light Ball, Thick Club, DeepSeaTooth e Soul Dew com suas condições de espécie;
- Eviolite, DeepSeaScale, Metal Powder e Soul Dew na defesa do alvo;
- BrightPowder e Lax Incense na precisão;
- Focus Sash e Focus Band na classificação de KO.

Expert Belt, Choice Specs e Life Orb foram marcados como confirmados pelas
descrições mostradas dentro do Infinity. Os demais usam o padrão Pokémon
compatível com a geração indicada pelos dados de TMs/HMs.

## Reconhecimento sem alteração direta de dano

Itens de cura, recuperação, status, prioridade, velocidade, crítico, evolução,
exploração, vitaminas, Poké Balls e itens-chave continuam registrados na base.
Eles não são usados como multiplicador de dano quando seu efeito não muda
diretamente o golpe atual.

Itens de crítico são reconhecidos, mas a previsão permanece deliberadamente
“sem crítico”, como já era antes.

## Itens ofensivos estruturados

BLACK BELT, BLACKGLASSES, BUG GEM, CHARCOAL, CHOICE BAND, CHOICE SPECS, DARK GEM, DEEPSEATOOTH, DRAGON FANG, DRAGON GEM, ELECTRIC GEM, EXPERT BELT, FIGHTING GEM, FIRE GEM, FLYING GEM, GHOST GEM, GRASS GEM, GROUND GEM, HARD STONE, ICE GEM, LIFE ORB, LIGHT BALL, MAGNET, METAL COAT, MIRACLE SEED, MUSCLE BAND, MYSTIC WATER, NEVERMELTICE, NORMAL GEM, POISON BARB, POISON GEM, PSYCHIC GEM, ROCK GEM, SEA INCENSE, SHARP BEAK, SILK SCARF, SILVERPOWDER, SOFT SAND, SOUL DEW, SPELL TAG, STEEL GEM, THICK CLUB, TWISTEDSPOON, WATER GEM, WISE GLASSES

## Itens defensivos/precisão/sobrevivência estruturados

BRIGHTPOWDER, DEEPSEASCALE, EVIOLITE, FOCUS BAND, FOCUS SASH, LAX INCENSE, METAL POWDER, SOUL DEW

## Preservado

- base de 197 TMs/HMs da InfinityWiki;
- alertas sonoros de 1 minuto e 30 segundos em segundo plano;
- contador no horário de Brasília;
- botão `✨ Pokémon apareceu` em largura total;
- alerta visual de Pokémon shiny;
- fórmula de captura;
- ordem fixa da interface;
- proteção da recomendação pelo time real;
- informações técnicas ocultas;
- crédito “Desenvolvido por: Lucca”;
- Pokébola no arredondamento;
- previsão de barras de boss;
- sincronização de golpes, Pokémon ativo, HP e PC;
- permissões `storage`, `alarms` e `offscreen`;
- nenhuma requisição adicional.

## Status

Status: BETA DE TESTE. A v0.2.6.1 continua sendo a versão oficial estável.

## Base preservada da v0.2.8.21

Mantém a correção da descrição do `manifest.json` para permanecer abaixo do limite da Chrome Web Store, além de todos os recursos da beta anterior.

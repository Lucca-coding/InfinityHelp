# InfinityHelp — v0.2.8.21 BETA DE TESTE

Extensão de navegador para auxiliar jogadores do Infinity MMO com informações de batalha e captura organizadas em um painel local.

> **Status:** versão beta de teste. A versão estável continua sendo a v0.2.6.1 até a conclusão dos testes.

## Objetivo deste repositório

Este repositório publica o código-fonte da versão beta para revisão técnica e transparência. A comunidade pode verificar as permissões utilizadas, o funcionamento da extensão e a ausência de código remoto ou automações de jogo.

## Funcionamento

A extensão lê dados que já foram carregados na página do Infinity MMO e exibe, entre outros recursos:

- IVs, atributos, natureza, habilidade e tipos;
- fraquezas, resistências e imunidades;
- recomendação baseada no time atual do jogador;
- chance de captura;
- estimativa de dano, chance de KO e barras de chefes;
- golpes, PP, TMs/HMs e itens equipados reconhecidos;
- alerta visual de encontro shiny;
- contador de eventos no horário de Brasília;
- alertas sonoros de 1 minuto e 30 segundos.

## Permissões

O `manifest.json` solicita apenas:

- `storage`: salva preferências e estado local do painel;
- `alarms`: agenda os alertas do contador de eventos;
- `offscreen`: reproduz os sons empacotados quando necessário;
- acesso somente a `https://infinitymmo.net/*` e `https://www.infinitymmo.net/*`.

A extensão não solicita acesso a todas as páginas, histórico, downloads, área de transferência, cookies, localização, câmera ou microfone.

## Transparência e segurança

- Manifest V3;
- nenhum JavaScript carregado de servidores externos;
- nenhuma biblioteca remota;
- nenhuma telemetria adicionada;
- nenhuma requisição de rede adicional criada pela extensão;
- nenhum `eval`, `new Function` ou WebAssembly;
- sons e imagens incluídos dentro do próprio pacote;
- funcionamento local no navegador.

O arquivo `page-hook.js` observa `fetch`, `XMLHttpRequest` e `WebSocket` da página para identificar dados que o próprio jogo já entrega ao navegador. Ele não cria comandos de batalha, captura ou movimentação.

## Arquivos principais

- `manifest.json`: permissões e configuração da extensão;
- `page-hook.js`: observação dos dados carregados pelo jogo;
- `content.js`: painel, cálculos e apresentação;
- `background.js`: alarmes e gerenciamento do áudio em segundo plano;
- `offscreen.js` / `offscreen.html`: reprodução local dos alertas;
- `pokemon-data.js`: base de Pokémon;
- `capture-data.js`: dados usados na estimativa de captura;
- `move-data.js`: base de golpes e TMs/HMs;
- `item-data.js`: reconhecimento e efeitos estruturados de itens;
- `popup.js` / `popup.html` / `popup.css`: configurações da extensão;
- `panel.css`: estilos do painel.

## Instalação manual para auditoria

1. Baixe ou clone este repositório.
2. Abra `chrome://extensions` no Chrome ou `edge://extensions` no Edge.
3. Ative o **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação**.
5. Selecione a pasta deste projeto, onde está o `manifest.json`.

## Verificação

Os hashes SHA-256 dos arquivos desta versão estão em `SHA256SUMS.txt`.

Uma revisão estática antes da publicação confirmou:

- sintaxe válida nos arquivos JavaScript;
- nenhum domínio externo além do Infinity MMO no manifesto;
- ausência de `eval`, `new Function` e código remoto;
- permissões limitadas a `storage`, `alarms` e `offscreen`.

Isso não substitui uma auditoria independente. O objetivo do repositório é justamente permitir essa revisão pública.

## Observações da versão

As alterações detalhadas da beta estão em [`docs/CHANGELOG-v0.2.8.21.md`](docs/CHANGELOG-v0.2.8.21.md).

## Direitos

Código publicado para inspeção e avaliação. Nenhuma licença de reutilização foi concedida neste repositório.

# Guia rápido para revisão do código

Para verificar os pontos mais sensíveis da extensão:

1. Abra `manifest.json` e confira permissões e domínios.
2. Revise `page-hook.js`, especialmente os wrappers de `fetch`, `XMLHttpRequest` e `WebSocket`.
3. Procure por chamadas de rede em todos os `.js`.
4. Revise `background.js`, `offscreen.js` e `offscreen.html` para os alertas de áudio.
5. Confira se todos os recursos são locais e se não existe código remoto.
6. Compare os hashes com `SHA256SUMS.txt`.

Comandos úteis em macOS/Linux:

```bash
grep -RInE "eval\(|new Function|WebAssembly|https?://" .
find . -type f -not -path './.git/*' -exec shasum -a 256 {} \;
```

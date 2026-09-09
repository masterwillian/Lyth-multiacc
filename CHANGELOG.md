# Changelog

## 0.2.1 — 2026-09-08

### Navegação e persistência

- Corrigida regressão que mantinha as webviews em `about:blank` após o boot.
- A navegação inicial agora aguarda o guest da webview estar pronto.
- URLs internas, como `about:blank`, não sobrescrevem mais a última URL da conta.
- Contas afetadas recuperam automaticamente a URL mais recente do histórico.
- Quando não existe URL recuperável, a conta volta ao endereço padrão de verificação.
- Histórico e URL persistida voltaram a ser atualizados por navegações HTTP/HTTPS.

## 0.2.0 — 2026-09-08

### Health-check

- ControlPort agora é autenticada pelo cookie do Tor.
- Bootstrap e circuito são consultados pelo protocolo de controle.
- Sessão Electron confirma a porta SOCKS configurada.
- Teste HTTPS periódico valida a saída real e registra o IP público.
- Verificações são escalonadas e recebem jitter para evitar rajadas.
- Três falhas consecutivas são toleradas antes de reiniciar uma instância saudável.
- Quedas do processo acionam recuperação imediatamente.
- Restarts têm trava contra concorrência e backoff exponencial.

### Logs e operação

- Logs de saúde idênticos deixaram de ser gravados a cada ciclo.
- Nível do Tor após carregar a configuração passou de `notice` para `warn`.
- Encerramentos intencionais não são mais tratados como falha.
- Timers de saúde e limpeza de cookies são encerrados corretamente.

### New Identity

- Corrigida autenticação hexadecimal do ControlPort.
- `SIGNAL NEWNYM` usa o cliente de controle compartilhado.
- Conexões antigas são fechadas antes da validação.
- O novo IP observado e a informação de mudança são devolvidos à interface.
- A interface informa corretamente quando o circuito muda, mas o exit relay é mantido.

### Qualidade

- Lógica de ControlPort e SOCKS extraída para módulos testáveis.
- Adicionados testes automatizados com `node:test`.
- Removido cabeçalho que afirmava incorretamente habilitar DoH.
- Removida API depreciada de preload de sessão.
- Corrigido carregamento inicial redundante de `about:blank` nas webviews.
- Versão atualizada para `0.2.0`.

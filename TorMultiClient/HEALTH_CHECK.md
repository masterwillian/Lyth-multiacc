# Health-check do hub-bliw

## Objetivo

O health-check confirma que cada conta não apenas possui um processo aberto, mas
que o Tor concluiu o bootstrap, estabeleceu um circuito, aceita tráfego SOCKS5 e
que a sessão Electron continua usando o proxy correto.

## Verificações

1. **Processo:** uma queda é detectada pelo evento `exit`, sem esperar o próximo ciclo.
2. **ControlPort:** autenticação por cookie e consultas a
   `status/bootstrap-phase` e `status/circuit-established`.
3. **Sessão Electron:** `resolveProxy` confirma a porta SOCKS atribuída à conta.
4. **Saída SOCKS5:** uma consulta HTTPS periódica obtém o IP público através do Tor.
5. **New Identity:** depois de `SIGNAL NEWNYM`, as conexões são fechadas e o IP de
   saída é consultado novamente. O Tor não garante que o IP será diferente.

## Navegação fail-closed

- Cada `partition` Electron recebe o proxy e um bloqueio de rede antes da criação das webviews.
- Requisições HTTP, HTTPS e WebSocket permanecem bloqueadas durante bootstrap, falhas e recuperação.
- A liberação ocorre somente após confirmar ControlPort, circuito, `resolveProxy` e o IP de saída pela própria sessão Chromium.
- A consulta de verificação é a única requisição externa permitida enquanto a conta está bloqueada.
- O cache HTTP da sessão fica desabilitado, o cache DNS é limpo antes do boot e a primeira navegação também solicita conteúdo sem cache.
- Se qualquer validação inicial falhar, o aplicativo mantém a navegação bloqueada e informa o erro no splash.

## Frequência e tolerância

- ControlPort e sessão: aproximadamente a cada 30 segundos.
- Saída SOCKS5: aproximadamente a cada 2 minutos.
- As contas recebem atrasos e jitter diferentes para evitar rajadas simultâneas.
- Uma queda do processo inicia recuperação imediatamente.
- Outras verificações exigem três falhas consecutivas antes do restart.
- Falhas de restart usam espera exponencial, limitada a 60 segundos.

## Estados

- `starting`: bootstrap em andamento.
- `ready`: circuito, proxy e último teste aplicável estão saudáveis.
- `degraded`: falha transitória; ainda abaixo do limite de recuperação.
- `recovering`: processo e sessão estão sendo reconstruídos.
- `error`: recuperação falhou e aguardará uma nova tentativa.
- `stopped`: encerramento intencional da conta ou do aplicativo.

## Logs

O arquivo por conta recebe registros somente quando status, mensagem ou dados
operacionais relevantes mudam. Checks positivos idênticos atualizam o estado em
memória, mas não acrescentam uma nova linha ao arquivo.

O Tor usa nível `warn` no terminal. O progresso de bootstrap é obtido pela
ControlPort, portanto mensagens `notice` repetitivas não são necessárias.

## Limites conhecidos

- O serviço externo de IP pode ficar indisponível independentemente do Tor.
- Um IP igual após `NEWNYM` não significa necessariamente que o comando falhou.
- Testes de WebRTC e vazamento DNS no contexto da página são auditorias de
  privacidade separadas e ainda precisam ser implementados.

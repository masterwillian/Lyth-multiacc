# Plano de melhorias — hub-bliw

## 1. Visão geral do projeto

Este projeto é um aplicativo desktop Electron para gerenciar múltiplas sessões de navegação isoladas, cada uma com seu próprio circuito Tor e sua própria identidade de rede. A ideia principal é permitir que o usuário abra diversos perfis de navegação em paralelo, com contas separadas por grupo, cada uma contando com um proxy SOCKS independente e um navegador Chromium isolado.

A arquitetura atual já entrega a base funcional:

- múltiplas instâncias Tor
- múltiplas sessões Electron isoladas por `partition`
- grupos e contas por lote
- UI para visualização em grid
- rotação de identidade via `SIGNAL NEWNYM`
- histórico de URL e IP
- filtro por grupos
- proteção básica contra fingerprinting
- bloqueio de alguns domínios de anúncio/tracking

No entanto, ele ainda é um protótipo funcional com muitos pontos de melhoria em estabilidade, observabilidade, organização e qualidade operacional.

---

## 2. O que o projeto consegue fazer hoje

### 2.1 Infraestrutura Tor por conta

Cada conta recebe:

- uma porta SOCKS local
- uma porta de controle local
- um diretório de dados separado
- um arquivo `torrc` próprio

Essa arquitetura é o coração do projeto. Ela fornece uma instância Tor e uma sessão Electron isolada para cada conta, sem prometer endereços IP de saída diferentes.

### 2.2 Sessões isoladas do Electron

Cada sessão do Chromium usa `session.fromPartition(...)` com um `partition` individual.

Isso é importante porque permite:

- cookies separados por conta
- cache separado por conta
- storage isolado por conta
- sessões com identidade simulada isolada

### 2.3 Rotação de identidade

O app usa o ControlPort do Tor para enviar:

- `AUTHENTICATE "<cookie>"`
- `SIGNAL NEWNYM`

Isso força a criação de um novo circuito Tor, permitindo trocar o IP da sessão de forma independente.

### 2.4 UI de gestão de grupos e contas

A aplicação tem:

- sidebar de grupos
- visão geral de contas
- layout 2x2 e 1x4
- foco em uma conta
- criação e exclusão de grupos
- adicionar/remover conta
- renomear conta
- ordenação visual

### 2.5 Proteções e controles de navegação

A aplicação também faz:

- User-Agent aleatório
- IP de saída verificado pelo health-check através do proxy Tor
- registro de histórico de IP
- bloqueio de domínios de anúncios/tracking
- proteção superficial de canvas/WebGL

---

## 3. Problemas e limitações atuais

### 3.1 Falta de monitoramento real de saúde

> Atualização v0.2.0: o monitoramento de processo, ControlPort autenticada,
> circuito, proxy da sessão, saída SOCKS e recuperação automática foi
> implementado. Consulte `HEALTH_CHECK.md`. Auditorias de WebRTC e DNS no
> contexto das páginas continuam pendentes.

Antes da v0.2.0, o app iniciava Tor e as sessões sem monitorização forte do estado de saúde de cada conta.

Os cenários que motivaram a atualização eram:

- instância Tor caiu e não foi reiniciada
- porta de controle ficou indisponível
- conta ficou sem proxy funcionando
- circuito sem resposta
- bootstrap falhando silenciosamente

### 3.2 Estado sem modelagem clara

O estado do sistema está espalhado:

- grupos salvos em JSON
- contas em memória
- `accountProcesses` e `accountSessions` em mapas
- histórico em `localStorage`
- alguma lógica em UI e outra em main process

Isso cria acoplamento e dificulta manutenção.

### 3.3 Falta de logs estruturados

Ainda existe foco em logs no console, mas não em logs por conta, por grupo, e por evento crítico.

Sem logs estruturados, fica difícil:

- diagnosticar falhas
- entender timeout
- rastrear New Identity
- ver se a sessão saiu do proxy

### 3.4 O armazenamento persistente é funcional, mas frágil

O arquivo [TorMultiClient/groups.json](TorMultiClient/groups.json) serve para salvar grupos, mas não é um sistema robusto de persistência.

Falta:

- validação do schema
- backup
- versionamento
- migração automática
- tratamento de arquivos corrompidos

### 3.5 A proteção anti-fingerprinting é manual e superficial

O app tenta esconder atributos de canvas/WebGL, mas isso é uma mitigação simples e não um sistema robusto de hardening da sessão.

Isso aponta para a necessidade de um módulo de isolamento mais bem pensado, não apenas pequenas overrides em JS.

### 3.6 A UI está boa, mas ainda é um dashboard de protótipo

A interface tem potencial, mas ainda falta:

- visão de status geral do sistema
- estado por conta
- saúde da sessão
- ações de recuperação
- gestão avançada de contas
- filtros e métricas úteis

---

## 4. Objetivo da melhoria

O objetivo não é apenas “mais botões na UI”. O objetivo real é transformar o projeto em uma plataforma sólida de gestão multi-sessão Tor com:

- estabilidade
- diagnósticos
- observabilidade
- isolamento confiável
- organização de dados
- aproveitamento melhor do Tor
- experiência de operação profissional

---

## 5. Melhorias prioritárias

## Fase 1 — Estabilização e confiabilidade

### 5.1 Monitoramento de saúde das instâncias Tor

Implementar um sistema de verificação contínua para cada instância:

- status da porta SOCKS
- status do ControlPort
- health check de bootstrap
- timeout de resposta
- reinício automático se cair
- marcação de falha por conta

### 5.2 Logs por conta e por grupo

Criar um sistema de logs estruturados em arquivos, como:

- logs/tor/<account>.log
- logs/session/<account>.log
- logs/errors.log

Cada evento deve ter:

- timestamp
- accountId
- groupId
- tipo de evento
- mensagem
- status

### 5.3 Tratamento robusto de bootstrap

Hoje há timeout e rejeição simples. Melhorar:

- verificar se o processo saiu antes do bootstrap
- tentar restart em histórico de falha
- reduzir risco de janela travada
- emitir eventos claros para a UI

### 5.4 Detecção e recuperação de sessão quebrada

Quando uma session do Electron falha:

- reiniciar a sessão isolada
- reconectar ao proxy correto
- limpar caches corrompidos
- reabrir a conta no painel

### 5.5 Validação de portas e arquivos

Antes de iniciar cada instância:

- verificar se a porta está indisponível
- verificar se o `torrc` foi gerado corretamente
- verificar se `DataDirectory` existe
- verificar se o tor.exe está presente

---

## Fase 2 — Organização de dados e persistência

### 5.6 Separar configuração de runtime

Criar estrutura de dados separada:

- config: grupos, nomes, tags, contas
- state: status da sessão, último IP, uptime, erro
- logs: histórico de eventos

### 5.7 Versionar o schema do JSON

Adicionar schema versioning em [TorMultiClient/groups.json](TorMultiClient/groups.json) e em novos arquivos de estado.

Exemplo:

- schemaVersion: 1
- migratedFrom: null

### 5.8 Backup e restore

Implementar:

- backup automático ao salvar grupos
- export do projeto de configuração
- import de snapshot
- restaurar um lote salvo anteriormente

### 5.9 Melhorar nomes e meta do lote

Adicionar:

- descrição de grupo
- tags mais visíveis
- notas de operação
- tags de padrão (QA, prod-like, scraping, testing)

---

## Fase 3 — Melhorias na UI e operação

### 5.10 Dashboard de saúde da conta

Adicionar painel com:

- status da tor instance
- porta do proxy
- IP atual
- última troca de identidade
- tempo desde última ação
- alertas

### 5.11 Filtros e organização visual

Melhorar:

- filtro por grupo
- filtro por status
- pesquisa por conta
- ordenação por nome/ID/status
- exibir contagem de contas por grupo

### 5.12 Ações de recuperação da conta

Botões extras ou menu:

- reiniciar conta
- resetar sessão
- limpar cookies
- limpar storage
- forçar nova identidade
- abrir no navegador em nova janela isolada

### 5.13 Melhorar a navegação do webview

- controle mais robusto de histórico
- botão de abrir em nova aba de conta
- indicar loading melhor
- indicação visual de erro de rede / proxy

---

## Fase 4 — Melhorias de isolamento e segurança

### 5.14 Módulo de hardening por sessão

Centralizar em um módulo específico a política de:

- WebGL
- Canvas
- AudioContext
- cookies
- cache
- storage
- user-agent

### 5.15 Reduzir o uso de hacks espalhados

Em vez de injetar scripts em vários pontos, criar um passo único de configuração da sessão com uma política clara e reutilizável.

### 5.16 Controle mais profissional de ad/tracking blocking

Hoje a lista é estática. Melhorar para:

- permitir configuração por grupo
- permitir ativar/desativar a regra
- extrair filtro para arquivo separado
- logs de bloqueios por domínio

---

## Fase 5 — Escalabilidade e arquitetura

### 5.17 Extrair módulos

Organizar em módulos como:

- tor-manager
- account-manager
- session-manager
- state-store
- logger
- ui-controller

### 5.18 Padronizar eventos IPC

Hoje há muitos `ipcMain.handle` e `ipcRenderer.on` espalhados. Melhorar para:

- contratos claros
- payloads consistentemente tipados
- eventos padronizados
- centralização do protocolo de comunicação

### 5.19 Criar utilitários comuns

Fazer utilitários como:

- port reservation checks
- file safe writes
- account normalization
- compute next account id
- generate torrc config

---

## 6. Melhorias do código de Tor

### 6.1 Extrair gerador de `torrc`

Hoje a função `ensureTorFiles()` gera o arquivo em um bloco. Melhorar para um módulo dedicado, com:

- configuração por conta
- validação de campos
- mais opções de Tor
- manipulação mais clara

### 6.2 Melhorar autenticação do ControlPort

Hoje o fluxo funciona, mas precisa de:

- retry em caso de falha curta
- verificação de resposta do AUTHENTICATE
- timeout mais robusto
- tratamento de caso em que o cookie ainda não foi criado

### 6.3 Tratar gracefully New Identity

Ao forçar nova identidade:

- limpar conexões da sessão imediatamente
- recomputar estado
- seta status correto na UI
- mostrar feedback visual para o usuário

### 6.4 Adicionar health-check de rede

Além de `checkIPviaSocks`, criar:

- verificação de DNS
- verificação de saída da WebGL / browser
- verificação de portas e circuito

---

## 7. Melhorias de UX

### 7.1 Notificações de eventos

Implementar pequenos toasts para:

- conta pronta
- Tor reiniciado
- New Identity concluído
- erro de bootstrap
- conta removida

### 7.2 Indicadores visuais de atividade

Cada painel deve mostrar claramente:

- pronto
- carregando
- rota via Tor
- sem proxy
- falha

### 7.3 Feedback para ações críticas

Ao remover conta, reiniciar tor, ou excluir grupo, o app deve mostrar:

- aviso claro
- confirmação
- efeito visual da ação

---

## 8. Melhorias de qualidade de código

### 8.1 Padronizar nomeação

Hoje há nomes misturados em português/inglês e convenções inconsistentes.

Objetivo:

- padronizar linguagem e nomenclatura
- usar convenção consistente em toda a base

### 8.2 Separar funções de UI e lógica de negócio

Hoje alguns trechos misturam:

- lógica de negócio
- atualização de DOM
- manipulação de eventos
- armazenamento local

Isso deve ser desmembrado em módulos claros.

### 8.3 Criar testes mínimos

Mesmo que o projeto não tenha framework, é importante começar com:

- teste de geração do `torrc`
- teste de cálculo de portas
- teste de criação de grupos
- teste de novas contas
- teste de `new identity` em mock de control port

---

## 9. Roadmap recomendado

## Sprint 1 — estabilidade

- health check por conta
- logs estruturados
- tratamento de bootstrap falho
- reinício de instância
- validação de portas e tor.exe

## Sprint 2 — persistência e dados

- schema versionado
- backup/restore
- separação de config/state
- export/import de grupos
- salvar status em arquivo

## Sprint 3 — UX e operação

- dashboard geral de status
- indicadores por conta
- toasts
- filtros e pesquisa
- histórico melhorado

## Sprint 4 — arquitetura e modularização

- extração de módulos
- padronização de IPC
- hardening por sessão
- limites de bloqueio/tracking mais claros

## Sprint 5 — polish e robustez

- automatizações
- templates de contas
- mais diagnósticos
- melhorias de manutenção

---

## 10. O que eu recomendo fazer agora

### Primeiro passo prático

1. criar um módulo de estado e monitoramento
2. centralizar logs
3. validar a saúde de cada Tor process
4. melhorar a gestão de falha no bootstrap
5. criar uma UI mínima de status geral

Isso resulta em um ganho imediato de confiabilidade e deixa o projeto pronto para evoluir sem cair em caos de manutenção.

---

## 11. Conclusão

O projeto tem base sólida e boa ideia principal, mas precisa passar do estágio de protótipo funcional para o estágio de plataforma operacional.

A evolução correta passa por:

- estabilidade de runtime
- modelagem de estados
- observabilidade
- organização de persistência
- UI mais operacional
- arquitetura mais limpa

Se essas melhorias forem feitas de maneira ordenada, o app pode se transformar em uma ferramenta muito mais útil e profissional.

---

## 12. Próximo passo sugerido

A próxima etapa é começar pela implementação direta das melhorias de estabilidade e monitoramento, começando por:

- saúde das contas
- logs estruturados
- bootstrap tracking
- estado global por conta
- visualização do status na UI

Esses itens dão retorno rápido e reduzem muito o risco de o sistema se tornar imprevisível.

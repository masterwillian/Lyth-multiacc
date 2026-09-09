# TorMultiClient

Aplicativo desktop para Windows construído com Electron. Ele executa múltiplas
sessões Chromium isoladas, cada uma conectada à sua própria instância Tor.

## Requisitos

- Windows
- Node.js 18 ou superior
- npm

## Executar

1. Entre na pasta `TorMultiClient`.
2. Execute `npm install`.
3. Execute `npm start` ou abra `start.cmd`.

O runtime do Tor utilizado pelo aplicativo fica em `tor/tor`. Os diretórios
`tor/instanceN` são criados localmente durante a execução e não são versionados,
pois contêm estado específico de cada sessão.

## Estado do projeto

O projeto ainda é um protótipo funcional. Consulte
`TorMultiClient/PLANO_MELHORIAS.md` para conhecer as limitações atuais e o
roadmap sugerido.

O funcionamento e os estados do monitoramento de cada instância estão descritos
em `TorMultiClient/HEALTH_CHECK.md`.

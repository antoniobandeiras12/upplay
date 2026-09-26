# UpPlay — Portal Oficial & Painel Administrativo

Landing page cinematográfica, página de download integrada e painel administrativo em tempo real com SQLite.

## Estrutura do Projeto

- `index.html`: Landing page principal para Android, catálogo de filmes, séries, esportes e instalação.
- `baixar.html`: Página intermediária de instrução de instalação com vídeo tutorial e botão de download oficial.
- `dev-server.js`: Servidor Node.js local para telemetria em tempo real, auditoria, autenticação administrativa e rotas controladas.
- `api/index.js`: Serverless Function para a Vercel com rotas `/api/*` e `/download`.
- `admin/`: Painel administrativo restrito (`/admin`) com métricas de visitantes ativos (<60s), cliques, solicitações de download e gráficos.
- `assets/`: Estilos CSS, scripts do rastreador, imagens oficiais e vídeo tutorial de instalação.
- `vercel.json`: Configuração de roteamento e deploy serverless para a Vercel.

## Como Rodar Localmente

1. Requer **Node.js v22+** (usa `node:sqlite` nativo):
```bash
npm start
```
2. Acesse:
- Site público: `http://localhost:3000/`
- Página de download: `http://localhost:3000/baixar`
- Painel Administrativo: `http://localhost:3000/admin`

3. Administrador inicial:
- **Usuário**: `admin`
- **Senha padrão**: `UpPlay2026!`

Para criar um novo administrador ou redefinir senha via linha de comando:
```bash
node dev-server.js --create-admin <usuario> <senha>
```

## Deploy na Vercel

1. Conecte o repositório GitHub (`https://github.com/antoniobandeiras12/upplay.git`) na sua conta da Vercel.
2. Nas configurações de **Environment Variables** na Vercel, adicione:
- `SESSION_SECRET`: Chave aleatória e segura para criptografia de sessões.
- `APK_DOWNLOAD_URL`: `https://gestaoseguro.top/play/upplay-streaming` (ou o link direto do APK).
- `INITIAL_ADMIN_USER`: `admin`
- `INITIAL_ADMIN_PASS`: Sua senha forte para o painel.
3. Clique em **Deploy**. A Vercel servirá os arquivos estáticos nas bordas (Edge CDN) e executará `api/index.js` sob demanda nas rotas `/api/*` e `/download`.

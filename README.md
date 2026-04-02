# 🏛️ Monitor Proposições SP — ALESP

Monitora automaticamente as proposições da Assembleia Legislativa do Estado de São Paulo e envia email quando há proposições novas. Roda **4x por dia** via GitHub Actions (8h, 12h, 17h e 21h, horário de Brasília).

---

## Como funciona

1. O GitHub Actions roda o script nos horários configurados
2. O script baixa o arquivo `proposituras.zip` do portal de Dados Abertos da ALESP
3. Descompacta o ZIP em memória e parseia o XML
4. Filtra apenas proposições do ano atual
5. Compara com os IDs já registrados no `estado.json`
6. Se há proposições novas → envia email organizado por tipo
7. Salva o estado atualizado no repositório

> **Diferença em relação ao monitor do PR:** a ALESP não tem API REST — disponibiliza um ZIP com XML atualizado diariamente. O script baixa e processa esse arquivo a cada execução.

---

## Fonte dos dados

```
URL: https://www.al.sp.gov.br/repositorioDados/processo_legislativo/proposituras.zip
Formato: ZIP contendo XML
Atualização: Diária (~03h30)
Documentação: https://www.al.sp.gov.br/dados-abertos/
```

---

## Estrutura do repositório

```
monitor-proposicoes-sp/
├── monitor.js                      # Script principal
├── package.json                    # Dependências
├── estado.json                     # Estado salvo automaticamente pelo workflow
├── README.md                       # Este arquivo
└── .github/
    └── workflows/
        └── monitor.yml             # Workflow do GitHub Actions
```

---

## Setup — Passo a Passo

### PARTE 1 — Preparar o Gmail

**1.1** Acesse [myaccount.google.com/security](https://myaccount.google.com/security)

**1.2** Certifique-se de que a **Verificação em duas etapas** está ativa.

**1.3** Procure por **"Senhas de app"** e clique.

**1.4** Digite um nome qualquer (ex: `monitor-alesp`) e clique em **Criar**.

**1.5** Copie a senha de **16 letras** gerada — ela só aparece uma vez.

> Se já usa o mesmo Gmail para outro monitor, pode reutilizar a mesma App Password.

---

### PARTE 2 — Criar o repositório no GitHub

**2.1** Acesse [github.com](https://github.com) → **+ → New repository**

**2.2** Preencha:
- **Repository name:** `monitor-proposicoes-sp`
- **Visibility:** Private

**2.3** Clique em **Create repository**

---

### PARTE 3 — Fazer upload dos arquivos

**3.1** Na página do repositório, clique em **"uploading an existing file"**

**3.2** Faça upload de:
```
monitor.js
package.json
README.md
```
Clique em **Commit changes**.

**3.3** O `monitor.yml` precisa estar numa pasta específica. Clique em **Add file → Create new file**, digite o nome:
```
.github/workflows/monitor.yml
```
Abra o arquivo `monitor.yml`, copie todo o conteúdo e cole. Clique em **Commit changes**.

---

### PARTE 4 — Configurar os Secrets

**4.1** No repositório: **Settings → Secrets and variables → Actions**

**4.2** Clique em **New repository secret** e crie os 3 secrets:

| Name | Valor |
|------|-------|
| `EMAIL_REMETENTE` | seu Gmail (ex: seuemail@gmail.com) |
| `EMAIL_SENHA` | a senha de 16 letras do App Password (sem espaços) |
| `EMAIL_DESTINO` | email onde quer receber os alertas |

---

### PARTE 5 — Testar

**5.1** Vá em **Actions → Monitor Proposições SP → Run workflow → Run workflow**

**5.2** Aguarde ~20–30 segundos (o ZIP da ALESP tem alguns MB).

**5.3** Resultado esperado no log:
```
📥 Baixando https://www.al.sp.gov.br/repositorioDados/...
✅ ZIP baixado: X.X MB
📦 Arquivos no ZIP: proposituras.xml
📊 Total de registros no XML: XXXX
📊 Proposições de 2026: XXX
🆕 Proposições novas: XXX
✅ Email enviado com XXX proposições novas.
```

**5.4** Verde = funcionou. O primeiro run envia email com todas as proposições do ano e salva o estado. A partir do segundo run, só envia se houver novidades.

---

## Email recebido

O email chega organizado por tipo, com número em ordem decrescente:

```
🏛️ ALESP — 5 nova(s) proposição(ões)

INDICAÇÃO — 2 proposição(ões)
  1500/2026 | - | 01/04/2026 | Indica ao Governador a implementação...
  1499/2026 | - | 01/04/2026 | Indica pavimentação...

PROJETO DE LEI — 1 proposição(ões)
  246/2026  | - | 01/04/2026 | Consolida as leis relativas ao TEA...
```

> **Nota sobre a coluna Autor:** a ALESP separa os autores em um arquivo ZIP diferente (`documento_autor.zip`). Por ora o campo aparece vazio. Se quiser cruzar os dados, abra um issue — é possível implementar numa segunda versão.

---

## Horários de execução

| Horário BRT | Cron UTC |
|-------------|----------|
| 08:00       | 0 11 * * * |
| 12:00       | 0 15 * * * |
| 17:00       | 0 20 * * * |
| 21:00       | 0 0 * * *  |

O ZIP da ALESP é atualizado por volta das 03h30 BRT, então o run das 08h já pega as proposições do dia.

---

## Resetar o estado

Para forçar o reenvio de todas as proposições:

1. No repositório, clique em `estado.json` → lápis
2. Substitua o conteúdo por:
```json
{"proposicoes_vistas":[],"ultima_execucao":""}
```
3. Commit → rode o workflow manualmente

---

## Problemas comuns

**Log mostra tags inesperadas no XML**
→ A ALESP pode ter alterado a estrutura do XML. Verifique a linha `🔍 Tag encontrada no XML:` no log para saber qual tag está sendo usada, e ajuste o script se necessário.

**ZIP maior que o esperado / timeout**
→ O ZIP da ALESP contém proposições de todos os anos. Em 2026 o arquivo pode ter vários MB. O GitHub Actions aguenta bem, mas se der timeout aumente o `timeout-minutes` no workflow.

**Erro "Authentication failed" no log**
→ Verifique se `EMAIL_SENHA` foi colado sem espaços.

**Rodou verde mas não veio email**
→ Pode ser o spam. Se não estiver lá, verifique no log se `🆕 Proposições novas: 0` — significa que o estado já tinha todas as proposições. Resete o estado (acima) para reenviar.

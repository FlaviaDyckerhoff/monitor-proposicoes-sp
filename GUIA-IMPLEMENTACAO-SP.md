# 🏛️ Guia de Implementação — Monitor ALESP-SP (São Paulo)

---

## Pré-requisitos

- Conta no [GitHub](https://github.com)
- Conta Gmail com verificação em duas etapas ativa
- Os 4 arquivos do monitor:
  - `monitor.js`
  - `package.json`
  - `monitor.yml`
  - `README.md`

---

## PARTE 1 — Gerar a Senha de App do Gmail

> Se já usa o mesmo Gmail para outro monitor (PR, RO, etc.), pode reutilizar a mesma App Password — pule para a Parte 2.

**1.1** Acesse [myaccount.google.com/security](https://myaccount.google.com/security)

**1.2** Confirme que **Verificação em duas etapas** está ativa.

**1.3** Na barra de busca da página, digite **"senhas de app"** e clique no resultado.

**1.4** Digite o nome `monitor-alesp-sp` e clique em **Criar**.

**1.5** Copie a senha de **16 letras** — aparece só uma vez.

---

## PARTE 2 — Criar o repositório no GitHub

**2.1** Acesse [github.com](https://github.com) → **"+"** → **New repository**

**2.2** Preencha:
- **Repository name:** `monitor-proposicoes-sp`
- **Visibility:** Private
- Deixe o resto desmarcado

**2.3** Clique em **Create repository**

---

## PARTE 3 — Fazer upload dos arquivos

**3.1** Na página do repositório, clique em **"uploading an existing file"**

**3.2** Arraste ou selecione os 3 arquivos:
```
monitor.js
package.json
README.md
```

**3.3** Clique em **Commit changes**.

---

## PARTE 4 — Criar o workflow do GitHub Actions

**4.1** No repositório, clique em **Add file → Create new file**

**4.2** No campo nome, digite exatamente:
```
.github/workflows/monitor.yml
```

**4.3** Abra o arquivo `monitor.yml`, copie todo o conteúdo e cole na área de edição.

**4.4** Clique em **Commit changes** → **Commit changes**.

---

## PARTE 5 — Configurar os Secrets

**5.1** No repositório: **Settings → Secrets and variables → Actions**

**5.2** Crie os 3 secrets (um por vez via **New repository secret**):

| Name | Valor |
|------|-------|
| `EMAIL_REMETENTE` | seu Gmail (ex: seuemail@gmail.com) |
| `EMAIL_SENHA` | a senha de 16 letras, **sem espaços** |
| `EMAIL_DESTINO` | email onde quer receber os alertas |

---

## PARTE 6 — Testar

**6.1** Vá em **Actions** → **Monitor Proposições SP** → **Run workflow** → **Run workflow**

**6.2** Aguarde ~20–30 segundos (a ALESP serve um ZIP, demora um pouco mais que o PR).

**6.3** Resultado esperado no log:
```
🚀 Iniciando monitor ALESP-SP...
📥 Baixando https://www.al.sp.gov.br/repositorioDados/...
✅ ZIP baixado: X.X MB
📦 Arquivos no ZIP: proposituras.xml
📊 Total de registros no XML: XXXX
📊 Proposições de 2026: XXX
🆕 Proposições novas: XXX
✅ Email enviado com XXX proposições novas.
```

**6.4** Verde = funcionou. Verifique a caixa de entrada (e spam, no primeiro email).

---

## Diferença técnica vs PR/RO

| | ALEP-PR / ALE-RO | ALESP-SP |
|---|---|---|
| Fonte | API REST (POST JSON) | ZIP com XML |
| Tamanho | ~KB por requisição | ~MB por download |
| Tempo de execução | ~10 seg | ~20–30 seg |
| Filtro por ano | No body do POST | No script, ao parsear |
| Campo autor | Incluso na resposta | Arquivo separado (omitido) |

---

## Como funciona no dia a dia

O ZIP é atualizado pela ALESP por volta das **03h30 BRT**. O workflow roda às 08h (primeiro horário) e já pega tudo que foi protocolado na véspera ou de madrugada.

| Horário BRT | Cron UTC |
|-------------|----------|
| 08:00 | `0 11 * * *` |
| 12:00 | `0 15 * * *` |
| 17:00 | `0 20 * * *` |
| 21:00 | `0 0 * * *` |

---

## Resetar o estado

**1.** No repositório, clique em `estado.json` → ícone de lápis

**2.** Substitua por:
```json
{"proposicoes_vistas":[],"ultima_execucao":""}
```

**3.** Commit → rode o workflow manualmente

---

## Problemas comuns

**Log mostra `📊 Proposições de 2026: 0`**
→ A tag XML pode ter mudado. Veja a linha `🔍 Tag encontrada no XML:` no log e reporte para ajuste.

**Erro "Authentication failed"**
→ Verifique se `EMAIL_SENHA` foi colado sem espaços.

**Workflow não aparece em Actions**
→ Confirme que o arquivo está em `.github/workflows/monitor.yml`.

**Rodou verde mas não veio email**
→ Verifique o spam. Se o log mostra `✅ Sem novidades`, resete o estado (acima).

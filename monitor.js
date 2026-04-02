const fs = require('fs');
const zlib = require('zlib');
const { DOMParser } = require('@xmldom/xmldom');
const AdmZip = require('adm-zip');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';

// URL do ZIP de proposituras da ALESP (atualizado diariamente ~03h30)
const URL_PROPOSITURAS = 'https://www.al.sp.gov.br/repositorioDados/processo_legislativo/proposituras.zip';

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

async function baixarZip(url) {
  console.log(`📥 Baixando ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  console.log(`✅ ZIP baixado: ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB`);
  return Buffer.from(buffer);
}

function extrairXmlDoZip(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  console.log(`📦 Arquivos no ZIP: ${entries.map(e => e.entryName).join(', ')}`);

  // Pega o primeiro arquivo XML encontrado
  const xmlEntry = entries.find(e => e.entryName.toLowerCase().endsWith('.xml'));
  if (!xmlEntry) {
    throw new Error('Nenhum arquivo XML encontrado no ZIP');
  }
  console.log(`📄 Usando arquivo: ${xmlEntry.entryName}`);
  return xmlEntry.getData().toString('utf8');
}

function getText(node, tagName) {
  const els = node.getElementsByTagName(tagName);
  if (els.length === 0) return '';
  const child = els[0].childNodes[0];
  return child ? child.nodeValue.trim() : '';
}

function parsearProposicoes(xmlStr, anoFiltro) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, 'text/xml');

  // A ALESP usa tags como <Propositura> ou <DocumentoItem>
  // Tenta diferentes nomes de tag
  let items = doc.getElementsByTagName('Propositura');
  if (items.length === 0) items = doc.getElementsByTagName('DocumentoItem');
  if (items.length === 0) items = doc.getElementsByTagName('propositura');
  if (items.length === 0) {
    // Tenta pegar o elemento raiz e ver quais filhos existem
    const root = doc.documentElement;
    if (root && root.childNodes) {
      for (let i = 0; i < root.childNodes.length; i++) {
        const node = root.childNodes[i];
        if (node.nodeType === 1) {
          console.log(`🔍 Tag encontrada no XML: ${node.tagName} (total de filhos do root)`);
          // Usa o tagName do primeiro elemento filho como tag de item
          items = doc.getElementsByTagName(node.tagName);
          break;
        }
      }
    }
  }

  console.log(`📊 Total de registros no XML: ${items.length}`);

  const proposicoes = [];
  const anoStr = String(anoFiltro);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // Campos possíveis da ALESP — mapeamento defensivo
    const idDoc = getText(item, 'IdDocumento') ||
                  getText(item, 'id') ||
                  getText(item, 'Codigo');

    const ano = getText(item, 'AnoExercicio') ||
                getText(item, 'Ano') ||
                getText(item, 'AnoLegislativo');

    if (ano !== anoStr) continue;

    const numero = getText(item, 'NroLegislativo') ||
                   getText(item, 'Numero') ||
                   getText(item, 'NrLegislativo');

    const natureza = getText(item, 'NaturezaAbreviacao') ||
                     getText(item, 'Natureza') ||
                     getText(item, 'SiglaNatureza') ||
                     getText(item, 'DescrNatureza');

    const ementa = getText(item, 'Ementa') ||
                   getText(item, 'dsEmenta') ||
                   getText(item, 'Assunto');

    const dataApresentacao = getText(item, 'DtEntradaSistema') ||
                             getText(item, 'DataApresentacao') ||
                             getText(item, 'DtApresentacao');

    if (!idDoc) continue;

    proposicoes.push({
      id: idDoc,
      tipo: natureza || 'OUTROS',
      numero: numero || '-',
      ano: ano,
      autor: '', // Autor está no documento_autor.zip separado — deixamos vazio por ora
      data: dataApresentacao || '-',
      ementa: (ementa || '-').substring(0, 250),
    });
  }

  console.log(`📊 Proposições de ${anoFiltro}: ${proposicoes.length}`);
  return proposicoes;
}

async function enviarEmail(novas) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  const porTipo = {};
  novas.forEach(p => {
    const tipo = p.tipo || 'OUTROS';
    if (!porTipo[tipo]) porTipo[tipo] = [];
    porTipo[tipo].push(p);
  });

  const linhas = Object.keys(porTipo).sort().map(tipo => {
    const header = `<tr><td colspan="5" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#1a3a5c;font-size:13px;border-top:2px solid #1a3a5c">${tipo} — ${porTipo[tipo].length} proposição(ões)</td></tr>`;
    const rows = porTipo[tipo]
      .sort((a, b) => (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0))
      .map(p =>
        `<tr>
          <td style="padding:8px;border-bottom:1px solid #eee;color:#555;font-size:12px">${p.tipo || '-'}</td>
          <td style="padding:8px;border-bottom:1px solid #eee"><strong>${p.numero || '-'}/${p.ano || '-'}</strong></td>
          <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autor || '-'}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.data || '-'}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.ementa || '-'}</td>
        </tr>`
    ).join('');
    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">
      <h2 style="color:#1a3a5c;border-bottom:2px solid #1a3a5c;padding-bottom:8px">
        🏛️ ALESP — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#1a3a5c;color:white">
            <th style="padding:10px;text-align:left">Tipo</th>
            <th style="padding:10px;text-align:left">Número/Ano</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Data</th>
            <th style="padding:10px;text-align:left">Ementa</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Acesse: <a href="https://www.al.sp.gov.br/alesp/pesquisa-proposicoes/">al.sp.gov.br — Pesquisa de Proposições</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor ALESP" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ ALESP: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} proposições novas.`);
}

(async () => {
  console.log('🚀 Iniciando monitor ALESP-SP...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas);

  const ano = new Date().getFullYear();

  let xmlStr;
  try {
    const zipBuffer = await baixarZip(URL_PROPOSITURAS);
    xmlStr = extrairXmlDoZip(zipBuffer);
  } catch (err) {
    console.error(`❌ Falha ao baixar/extrair ZIP: ${err.message}`);
    process.exit(1);
  }

  const proposicoes = parsearProposicoes(xmlStr, ano);

  if (proposicoes.length === 0) {
    console.log('⚠️ Nenhuma proposição encontrada para o ano atual.');
    // Salva execução mesmo sem resultados
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
    process.exit(0);
  }

  const novas = proposicoes.filter(p => !idsVistos.has(p.id));
  console.log(`🆕 Proposições novas: ${novas.length}`);

  if (novas.length > 0) {
    await enviarEmail(novas);
    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
  }

  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();

const fs = require('fs');
const { DOMParser } = require('@xmldom/xmldom');
const AdmZip = require('adm-zip');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';

const URL_PROPOSITURAS = 'https://www.al.sp.gov.br/repositorioDados/processo_legislativo/proposituras.zip';
const URL_NATUREZAS   = 'https://www.al.sp.gov.br/repositorioDados/processo_legislativo/naturezasSpl.xml';

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

async function baixarBuffer(url) {
  console.log(`📥 Baixando ${url}...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const buffer = await response.arrayBuffer();
  console.log(`✅ Baixado: ${(buffer.byteLength / 1024).toFixed(0)} KB`);
  return Buffer.from(buffer);
}

function extrairXmlDoZip(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  console.log(`📦 Arquivos no ZIP: ${entries.map(e => e.entryName).join(', ')}`);
  const xmlEntry = entries.find(e => e.entryName.toLowerCase().endsWith('.xml'));
  if (!xmlEntry) throw new Error('Nenhum arquivo XML encontrado no ZIP');
  console.log(`📄 Usando arquivo: ${xmlEntry.entryName}`);
  return xmlEntry.getData().toString('utf8');
}

function getText(node, tagName) {
  const els = node.getElementsByTagName(tagName);
  if (els.length === 0) return '';
  const child = els[0].childNodes[0];
  return child ? child.nodeValue.trim() : '';
}

function dumpCampos(node) {
  const campos = {};
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child.nodeType === 1) {
      const val = child.childNodes[0] ? child.childNodes[0].nodeValue : '';
      campos[child.tagName] = val;
    }
  }
  return campos;
}

function descobrirTagItem(doc) {
  const root = doc.documentElement;
  for (let i = 0; i < root.childNodes.length; i++) {
    if (root.childNodes[i].nodeType === 1) return root.childNodes[i].tagName;
  }
  return null;
}

// Campos confirmados do naturezasSpl.xml:
//   <idNatureza>, <sgNatureza>, <nmNatureza>
async function carregarNaturezas() {
  try {
    const buf = await baixarBuffer(URL_NATUREZAS);
    const xmlStr = buf.toString('utf8');
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlStr, 'text/xml');

    const items = doc.getElementsByTagName('natureza');
    console.log(`📋 Naturezas carregadas: ${items.length}`);

    const mapa = {};
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const id    = getText(item, 'idNatureza');
      const sigla = getText(item, 'sgNatureza');
      const nome  = getText(item, 'nmNatureza');
      if (id) mapa[id] = sigla || nome || id;
    }
    // Log de amostra para confirmar
    console.log(`📋 Amostra: id=1→"${mapa['1']}", id=8→"${mapa['8']}", id=9→"${mapa['9']}"`);
    return mapa;
  } catch (err) {
    console.warn(`⚠️ Não foi possível carregar naturezas: ${err.message}`);
    return {};
  }
}

function parsearProposicoes(xmlStr, naturezas, anoFiltro) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, 'text/xml');

  const tagItem = descobrirTagItem(doc);
  if (!tagItem) { console.error('❌ Tag de item não encontrada'); return []; }
  console.log(`🔍 Tag de item no XML: <${tagItem}>`);

  const items = doc.getElementsByTagName(tagItem);
  console.log(`📊 Total de registros no XML: ${items.length}`);

  // Dump do 1º item — para diagnóstico dos campos do proposituras.xml
  if (items.length > 0) {
    console.log('🔬 Campos do 1º item:', JSON.stringify(dumpCampos(items[0])));
  }

  const proposicoes = [];
  const anoStr = String(anoFiltro);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    const idDoc = getText(item, 'IdDocumento') || getText(item, 'Codigo') || getText(item, 'id');

    const ano = getText(item, 'AnoExercicio') || getText(item, 'Ano') || getText(item, 'AnoLegislativo');
    if (ano !== anoStr) continue;

    const numero = getText(item, 'NroLegislativo') || getText(item, 'Numero') || getText(item, 'NrLegislativo');

    // Tenta campo de tipo inline (várias variações de caixa)
    // Se não achar, usa dicionário pelo idNatureza (campo confirmado no naturezasSpl.xml)
    let tipo = getText(item, 'sgNatureza')
            || getText(item, 'nmNatureza')
            || getText(item, 'NaturezaAbreviacao')
            || getText(item, 'SiglaNatureza');

    if (!tipo) {
      const idNat = getText(item, 'idNatureza')
                 || getText(item, 'IdNatureza')
                 || getText(item, 'CdNatureza');
      if (idNat && naturezas[idNat]) tipo = naturezas[idNat];
    }

    const ementa = getText(item, 'Ementa') || getText(item, 'dsEmenta') || getText(item, 'Assunto');

    let data = getText(item, 'DtEntradaSistema') || getText(item, 'DataApresentacao') || getText(item, 'DtApresentacao') || '-';
    if (data.includes('T')) data = data.split('T')[0];

    if (!idDoc) continue;

    proposicoes.push({
      id: idDoc,
      tipo: tipo || 'OUTROS',
      numero: numero || '-',
      ano,
      data,
      ementa: (ementa || '-').substring(0, 300),
      link: `https://www.al.sp.gov.br/propositura/?id=${idDoc}`,
    });
  }

  // Log de amostra dos tipos encontrados
  const tiposUnicos = [...new Set(proposicoes.map(p => p.tipo))].slice(0, 10);
  console.log(`📊 Proposições de ${anoFiltro}: ${proposicoes.length}`);
  console.log(`📊 Tipos encontrados (amostra): ${tiposUnicos.join(', ')}`);
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
    const header = `<tr><td colspan="4" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#1a3a5c;font-size:13px;border-top:2px solid #1a3a5c">${tipo} — ${porTipo[tipo].length} proposição(ões)</td></tr>`;
    const rows = porTipo[tipo]
      .sort((a, b) => (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0))
      .map(p => `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">
          <a href="${p.link}" style="color:#1a3a5c;font-weight:bold;text-decoration:none">${p.numero}/${p.ano}</a>
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;color:#555;white-space:nowrap">${p.data}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px">${p.ementa}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">
          <a href="${p.link}" style="font-size:11px;color:#1a7bc4;text-decoration:none">🔗 ver</a>
        </td>
      </tr>`).join('');
    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">
      <h2 style="color:#1a3a5c;border-bottom:2px solid #1a3a5c;padding-bottom:8px">
        🏛️ ALESP — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666;font-size:13px">Monitoramento automático — ${new Date().toLocaleString('pt-BR', {timeZone:'America/Sao_Paulo'})}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#1a3a5c;color:white">
            <th style="padding:10px;text-align:left">Número</th>
            <th style="padding:10px;text-align:left">Data</th>
            <th style="padding:10px;text-align:left">Ementa</th>
            <th style="padding:10px;text-align:left">Link</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Fonte: <a href="https://www.al.sp.gov.br/dados-abertos/">Portal Dados Abertos ALESP</a>
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
  console.log(`⏰ ${new Date().toLocaleString('pt-BR', {timeZone:'America/Sao_Paulo'})}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas);
  const ano = new Date().getFullYear();

  let zipBuffer, naturezas;
  try {
    [zipBuffer, naturezas] = await Promise.all([
      baixarBuffer(URL_PROPOSITURAS),
      carregarNaturezas(),
    ]);
  } catch (err) {
    console.error(`❌ Falha ao baixar dados: ${err.message}`);
    process.exit(1);
  }

  const xmlStr = extrairXmlDoZip(zipBuffer);
  const proposicoes = parsearProposicoes(xmlStr, naturezas, ano);

  if (proposicoes.length === 0) {
    console.log('⚠️ Nenhuma proposição encontrada. Verifique o dump 🔬 acima.');
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

const fs = require('fs');
const { DOMParser } = require('@xmldom/xmldom');
const AdmZip = require('adm-zip');
const nodemailer = require('nodemailer');
const iconv = require('iconv-lite');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const CONTROLE03_FORCE_LATEST = String(process.env.CONTROLE03_FORCE_LATEST || '').trim() === '1';
const ARQUIVO_ESTADO = 'estado.json';
const RADAR03_URL = process.env.RADAR03_URL || 'https://doe.monitorlegislativo.com.br/controle03/';
const CASA_RADAR03 = process.env.CASA_RADAR03 || 'ALESP';
const CONTROLE03_STATE_URL = process.env.CONTROLE03_STATE_URL || new URL('api/state', RADAR03_URL).toString();
const CONTROLE03_API_USER = process.env.CONTROLE03_API_USER || '';
const CONTROLE03_API_PASS = process.env.CONTROLE03_API_PASS || '';
const CONTROLE03_BASIC_AUTH = process.env.CONTROLE03_BASIC_AUTH || '';


const URL_PROPOSITURAS = 'https://www.al.sp.gov.br/repositorioDados/processo_legislativo/proposituras.zip';
const URL_NATUREZAS   = 'https://www.al.sp.gov.br/repositorioDados/processo_legislativo/naturezasSpl.xml';
const URL_AGENDA_2026 = 'https://www.al.sp.gov.br/repositorioDados/agenda/agenda_eventos_2026.xml';
// Regra operacional: listar todos os eventos oficiais publicados na agenda ALESP
// pelos próximos 60 dias, excluindo reservas/bloqueios internos de sala.
const DIAS_AGENDA_FRENTE = 60;

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

async function baixarBuffer(url, timeoutMs = 30000) {
  console.log(`📥 Baixando ${url}...`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    console.log(`✅ Baixado: ${(buffer.byteLength / 1024).toFixed(0)} KB`);
    return Buffer.from(buffer);
  } finally {
    clearTimeout(timeout);
  }
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

function formatarDataIso(dataIso) {
  if (!dataIso || dataIso.length < 10) return '-';
  const [ano, mes, dia] = dataIso.substring(0, 10).split('-');
  return dia + '/' + mes + '/' + ano;
}

function escaparHtml(valor) {
  return String(valor || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function adicionarDias(data, dias) {
  const result = new Date(data);
  result.setDate(result.getDate() + dias);
  return result;
}

function isoLocal(data) {
  return [
    data.getFullYear(),
    String(data.getMonth() + 1).padStart(2, '0'),
    String(data.getDate()).padStart(2, '0'),
  ].join('-');
}

function normalizarTextoBusca(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function eventoAgendaBloqueado(evento) {
  const texto = normalizarTextoBusca([
    evento.titulo,
    evento.local,
    evento.descricao,
  ].join(' '));

  return /\bBLOQUEAD[OA]S?\b/.test(texto)
    || /\bMANUTENCAO\b/.test(texto)
    || /\bRESERVAD[OA]S?\b/.test(texto);
}

function parsearAgenda(xmlStr, limite = Number.POSITIVE_INFINITY, diasParaFrente = DIAS_AGENDA_FRENTE) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, 'text/xml');
  const items = doc.getElementsByTagName('Evento');
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const dataLimite = adicionarDias(hoje, diasParaFrente);

  const eventos = [];
  const idsVistos = new Set();
  let bloqueadosIgnorados = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const id = getText(item, 'IdEvento');
    const dataRaw = getText(item, 'Data');
    const dataIso = dataRaw.substring(0, 10);
    const data = new Date(dataIso + 'T00:00:00-03:00');
    if (!dataIso || Number.isNaN(data.getTime()) || data < hoje || data > dataLimite) continue;

    const titulo = getText(item, 'Titulo');
    const descricao = getText(item, 'Descricao');
    const obs = getText(item, 'Obs');
    const local = getText(item, 'Local');
    const evento = {
      id,
      data: dataIso,
      hora: getText(item, 'HoraIni') || '-',
      titulo,
      local: local || '-',
      descricao: (descricao || obs || '-').substring(0, 220),
    };

    if (eventoAgendaBloqueado(evento)) {
      bloqueadosIgnorados++;
      continue;
    }

    const chave = [id, dataIso, getText(item, 'HoraIni'), titulo].join('|');

    if (idsVistos.has(chave)) continue;

    idsVistos.add(chave);
    eventos.push(evento);
  }

  eventos.sort((a, b) => (a.data + ' ' + a.hora).localeCompare(b.data + ' ' + b.hora));
  const eventosLimitados = eventos.slice(0, limite);
  return {
    eventos: eventosLimitados,
    dataInicio: isoLocal(hoje),
    dataLimite: isoLocal(dataLimite),
    diasParaFrente,
    totalEncontrados: eventos.length,
    totalExibidos: eventosLimitados.length,
    bloqueadosIgnorados,
    ultimaData: eventos.length ? eventos[eventos.length - 1].data : null,
  };
}

async function carregarAgendaAlesp() {
  try {
    const buf = await baixarBuffer(URL_AGENDA_2026);
    const agenda = parsearAgenda(buf.toString('utf8'));
    console.log('🗓️ Agenda da Assembleia Legislativa de São Paulo — janela ' +
      formatarDataIso(agenda.dataInicio) + ' a ' + formatarDataIso(agenda.dataLimite) +
      ': ' + agenda.totalEncontrados + ' evento(s) oficial(is) encontrado(s), ' +
      (agenda.bloqueadosIgnorados || 0) + ' bloqueio(s)/reserva(s) ignorado(s)');
    return agenda;
  } catch (err) {
    console.warn('⚠️ Não foi possível carregar agenda ALESP: ' + err.message);
    return { eventos: [], dataInicio: null, dataLimite: null, diasParaFrente: DIAS_AGENDA_FRENTE, totalEncontrados: 0, totalExibidos: 0, ultimaData: null };
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
      ementa: (ementa || '-'),
      link: `https://www.al.sp.gov.br/propositura/?id=${idDoc}`,
    });
  }

  // Log de amostra dos tipos encontrados
  const tiposUnicos = [...new Set(proposicoes.map(p => p.tipo))].slice(0, 10);
  console.log(`📊 Proposições de ${anoFiltro}: ${proposicoes.length}`);
  console.log(`📊 Tipos encontrados (amostra): ${tiposUnicos.join(', ')}`);
  return proposicoes;
}

function limparHtml(valor) {
  return String(valor || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&ccedil;/g, 'ç')
    .replace(/&atilde;/g, 'ã')
    .replace(/&otilde;/g, 'õ')
    .replace(/&aacute;/g, 'á')
    .replace(/&eacute;/g, 'é')
    .replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú')
    .replace(/&agrave;/g, 'à')
    .replace(/&ecirc;/g, 'ê')
    .replace(/&ocirc;/g, 'ô')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function dataBrParaIso(dataBr) {
  const m = String(dataBr || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return dataBr || '-';
  return m[3] + '-' + m[2] + '-' + m[1];
}

function parsearListagemProposicoes(html, tipoFallback, anoFiltro) {
  const proposicoes = [];
  const regex = /<a class="tituloItem"[^>]+href="\/propositura\/\?id=(\d+)&tipo=(\d+)&ano=(\d+)"[^>]*>\s*([\s\S]*?)\s*<\/a>\s*<br>\s*<p>([\s\S]*?)<\/p>/g;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const id = match[1];
    const titulo = limparHtml(match[4]);
    const ementa = limparHtml(match[5]);
    const dadosTitulo = titulo.match(/^(.+?)\s+(\d+)\/(\d{4}),\s+de\s+(\d{2}\/\d{2}\/\d{4})/i);
    if (!dadosTitulo || dadosTitulo[3] !== String(anoFiltro)) continue;

    proposicoes.push({
      id,
      tipo: dadosTitulo[1] || tipoFallback,
      numero: dadosTitulo[2] || '-',
      ano: dadosTitulo[3],
      data: dataBrParaIso(dadosTitulo[4]),
      ementa: (ementa || '-'),
      link: 'https://www.al.sp.gov.br/propositura/?id=' + id,
      fonte: 'busca_publica',
    });
  }

  return proposicoes;
}

async function carregarProposicoesListagem(ano) {
  const tipos = [
    ['1', 'Projeto de Lei'],
    ['9', 'Indicação'],
    ['4005', 'Emendas e Substitutivos'],
    ['4001', 'Anexos'],
    ['2', 'Projeto de Lei Complementar'],
    ['6', 'Moção'],
    ['4000', 'Parecer'],
    ['18', 'Autógrafo'],
    ['5', 'Proposta de Emenda à Constituição'],
    ['7', 'Requerimento'],
    ['108', 'Proposta de Alteração (Governador)'],
    ['19', 'Ofício'],
    ['4', 'Projeto de Decreto Legislativo'],
    ['8', 'Requerimento de Informação'],
    ['47', 'Mensagem Aditiva'],
    ['4002', 'Veto'],
    ['3', 'Projeto de Resolução'],
  ];

  const todas = [];
  for (const [tipoId, tipoNome] of tipos) {
    const url = 'https://www.al.sp.gov.br/alesp/projetos/?tipo=' + tipoId + '&ano=' + ano;
    const timeoutMs = tipoId === '9' ? 90000 : 20000;
    try {
      const buf = await baixarBuffer(url, timeoutMs);
      const encontradas = parsearListagemProposicoes(iconv.decode(buf, 'latin1'), tipoNome, ano);
      console.log('🔎 Busca pública ALESP ' + tipoNome + ': ' + encontradas.length + ' item(ns)');
      todas.push(...encontradas);
    } catch (err) {
      console.warn('⚠️ Falha na busca pública ALESP ' + tipoNome + ': ' + err.message);
    }
  }

  return todas;
}

function mesclarProposicoes(fontes) {
  const porId = new Map();
  fontes.flat().forEach(p => {
    if (!p || !p.id) return;
    const atual = porId.get(p.id);
    if (!atual || atual.fonte !== 'busca_publica') porId.set(p.id, p);
  });
  return Array.from(porId.values());
}

function montarSecaoAgenda(agendaAlesp) {
  const eventosAgenda = Array.isArray(agendaAlesp) ? agendaAlesp : (agendaAlesp && agendaAlesp.eventos) || [];
  const meta = Array.isArray(agendaAlesp) ? {} : (agendaAlesp || {});
  const janela = meta.dataInicio && meta.dataLimite
    ? 'Janela consultada: ' + formatarDataIso(meta.dataInicio) + ' a ' + formatarDataIso(meta.dataLimite) + ' (' + (meta.diasParaFrente || DIAS_AGENDA_FRENTE) + ' dias). '
    : '';
  if (!eventosAgenda || eventosAgenda.length === 0) {
    return '<h3 style="margin-top:28px;color:#1a3a5c;border-bottom:1px solid #d8e0ea;padding-bottom:6px">Agenda da Assembleia Legislativa de São Paulo</h3>' +
      '<p style="color:#666;font-size:12px;margin-top:0">' + janela + 'Nenhum evento oficial encontrado na agenda da ALESP para os próximos 60 dias.</p>';
  }

  const rows = eventosAgenda.map(e => '<tr>' +
    '<td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;color:#555;white-space:nowrap">' + formatarDataIso(e.data) + ' ' + escaparHtml(e.hora) + '</td>' +
    '<td style="padding:8px;border-bottom:1px solid #eee;font-size:13px">' + escaparHtml(e.titulo) + '</td>' +
    '<td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;color:#555">' + escaparHtml(e.local) + '</td>' +
  '</tr>').join('');

  return '<h3 style="margin-top:28px;color:#1a3a5c;border-bottom:1px solid #d8e0ea;padding-bottom:6px">Agenda da Assembleia Legislativa de São Paulo</h3>' +
    '<p style="color:#666;font-size:12px;margin-top:0">' + janela + 'Eventos oficiais publicados na agenda da ALESP dentro dos próximos 60 dias.</p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
      '<thead><tr style="background:#eef3f8;color:#1a3a5c">' +
        '<th style="padding:9px;text-align:left">Data</th>' +
        '<th style="padding:9px;text-align:left">Evento</th>' +
        '<th style="padding:9px;text-align:left">Local</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>';
}

function prioridadeTipoEmail(tipo) {
  const t = normalizarTextoBusca(tipo);

  if (/^(PL|PLO)(\b|$)/.test(t) || /^PROJETO DE LEI( ORDINARIA)?$/.test(t)) return 0;
  if (/^PLC(\b|$)/.test(t) || /^PROJETO DE LEI COMPLEMENTAR/.test(t)) return 1;
  if (/^PEC(\b|$)/.test(t) || /^(PROPOSTA|PROJETO) DE EMENDA (A )?CONSTITUCIONAL/.test(t)) return 2;
  return 10;
}

function compararTiposEmail(a, b) {
  const prioridadeA = prioridadeTipoEmail(a);
  const prioridadeB = prioridadeTipoEmail(b);
  if (prioridadeA !== prioridadeB) return prioridadeA - prioridadeB;
  return String(a || '').localeCompare(String(b || ''), 'pt-BR');
}


const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario',
  'Boticário', 'Grupo Boticario', 'Grupo Boticário', 'O Boticario',
  'O Boticário', 'Abrasel', 'Abrasel PB', 'Abrasel Paraíba',
  'ANBRASEL', 'Ambev', 'Heineken', 'Abralatas',
  'ABIR', 'Coca-Cola', 'Coca Cola', 'Coca-Cola Company',
  'Femsa', 'Solar', 'Grupo Simões', 'Grupo Simoes',
  'Andina', 'CVI', 'iFood', 'Zé Delivery',
  'Ze Delivery', 'Verde Brasil', 'JCRIG', 'Associação dos Cemitérios e Crematórios do Brasil',
  'Associacao dos Cemiterios e Crematorios do Brasil', 'Lalamove', 'Matrix', 'CVC',
  'Rei do Pitaco', 'Maersk', 'Mac Jee', 'Norte Energia',
  'Pacto Pela Fome', 'Sanofi', 'TikTok', 'Minalba',
  'Esmaltec', 'Nacional Gás', 'Nacional Gas', 'Syngenta',
  'Braskem', 'Ypê', 'Ype', 'VTal',
  'V.tal', 'Grupo EPR', 'EPR', 'Natural Energia',
  'DIAGEO', 'Alpargatas', 'Ternium', 'ABRADEE',
  'Eletrobras', 'Eletrobrás', 'MeetKai', 'IPQ',
  'Equatorial', 'EquatorialEnergia', 'Equatorial Energia', 'Equatorial Goiás',
  'Equatorial Goias', 'Equatorial Goiás Distribuidora de Energia', 'Equatorial Goias Distribuidora de Energia', 'CEA Equatorial',
  'CEA Equatorial Energia', 'Equtorial', 'Energisa', 'EnergisaLuz',
  'Neoenergia', 'ENEL', 'Ampla Energia', 'SABESP',
  'COMGAS', 'COMGÁS', 'AEGEA', 'Aegea Saneamento',
  'Águas de Teresina', 'Aguas de Teresina', 'Águas de Timon', 'Aguas de Timon',
  'Águas do Rio', 'Aguas do Rio', 'Águas do Rio 1', 'Águas do Rio 4',
  'Naturgy', 'Agenersa', 'Regenera', 'Comlurb',
  'Hekos', 'Orizon', 'Solvi', 'União Norte',
  'Uniao Norte', 'Vital', 'Eletromidia', 'Eletromídia',
  'AkzoNobel', 'Expedia', 'Hotels.com', 'Vrbo',
  'RTSC', 'Gramado Parks', 'Grupo Wish', 'Huawei',
  'Carrefour', 'Atacadão', 'Atacadao', 'Walmart',
  "Sam's Club", 'Sams Club', 'JBS', 'Friboi',
  'Seara', 'Swift', "Pilgrim's", 'Pilgrims',
  'Wild Fork', 'Ajinomoto', 'Vibra', 'Vibra Energia',
  'BR Distribuidora', 'Raízen', 'Raizen', 'Mindlab',
  'ABVTEX', 'Semove', 'Barcas', 'Seta',
  'Nova Infra', 'BRT'
];

const CLIENTES_INATIVOS_NAO_DESTACAR = [
  'CVC', 'DIAGEO', 'Femsa', 'Lalamove', 'lalamove',
  'Maersk', 'Matrix', 'Rei do Pitaco', 'Sanofi', 'Syngenta',
  'Ypê', 'Ype', 'Braskem', 'Vital', 'Natural Energia',
  'Pacto Pela Fome', 'TikTok', 'Norte Energia', 'Mac Jee',
  'Solar', 'Grupo Simões', 'Grupo Simoes'
];

function clienteAtivoParaDestaque(nome) {
  return !CLIENTES_INATIVOS_NAO_DESTACAR.some(inativo => inativo.toLowerCase() === String(nome || '').toLowerCase());
}

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    if (!clienteAtivoParaDestaque(nome)) continue;
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return achados;
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !(String(p.ementa).includes('Cliente citado:') || String(p.ementa).includes('CLIENTE CITADO:'))) {
      p.ementa = String(p.ementa).trim() + ' | Cliente citado: ' + clientes.join(', ');
    }
  }
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .filter(clienteAtivoParaDestaque)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#fff1f2;color:#991b1b;font-weight:800;border:1px solid #fecdd3;border-radius:3px;padding:1px 4px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+(?:🆘\s*)?CLIENTE CITADO:\s+|\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | Cliente citado: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#fff1f2;border:1px solid #fb7185;color:#991b1b;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0">' +
    '🆘 CLIENTE CITADO: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}


function clientesCitadosResumoEmail(novas) {
  const nomes = [];
  for (const p of novas || []) {
    for (const nome of (Array.isArray(p && p.clientesCitados) ? p.clientesCitados : [])) {
      if (nome && !nomes.some(n => n.toLowerCase() === String(nome).toLowerCase())) nomes.push(String(nome));
    }
  }
  return nomes;
}

function assuntoEmailClienteCitado(novas, assuntoBase) {
  const nomes = clientesCitadosResumoEmail(novas);
  if (!nomes.length) return assuntoBase;
  const lista = nomes.slice(0, 3).join(', ') + (nomes.length > 3 ? ' +' + (nomes.length - 3) : '');
  const base = String(assuntoBase || '');
  return base.startsWith('🆘') ? base : '🆘 Cliente citado: ' + lista + ' | ' + base;
}

function radar03Numero(p) {
  const numero = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const ano = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numero) return '';
  if (numero.includes('/') || !ano) return numero;
  return numero + '/' + ano;
}

function radar03NumeroPartes(p) {
  const numeroRaw = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const anoRaw = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numeroRaw) return null;

  const match = numeroRaw.match(/^(\d+)\s*\/\s*(\d{2,4})$/);
  const numero = match ? match[1] : numeroRaw;
  const ano = match ? match[2] : anoRaw;
  const numeroInt = parseInt(numero, 10);
  if (!Number.isFinite(numeroInt)) return null;

  return {
    numero,
    numeroInt,
    ano: ano && ano.length === 2 ? '20' + ano : ano,
  };
}

function radar03BlocoEmail(novas) {
  return radar03AgruparNovidades(novas)
    .map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : ''))
    .join(' | ');
}

function radar03PrimeiraFonte(novas) {
  const item = (novas || []).find(p => p?.link || p?.url || p?.fonte || p?.projeto_url);
  return item ? String(item.link || item.url || item.fonte || item.projeto_url || '') : '';
}

function radar03TipoControle(tipo) {
  const normal = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const mapa = {
    'PROJETO DE LEI': 'PL',
    'PROJETO LEI': 'PL',
    'PROJETO DE LEI ORDINARIA': 'PL',
    'PLO': 'PL',
    'PL': 'PL',
    'PL - PROJETO DE LEI': 'PL',
    'PL PROJETO DE LEI': 'PL',
    'PROJETO DE LEI COMPLEMENTAR': 'PLC',
    'PLC': 'PLC',
    'PLC - PROJETO DE LEI COMPLEMENTAR': 'PLC',
    'PLC PROJETO DE LEI COMPLEMENTAR': 'PLC',
    'PROPOSTA DE EMENDA A CONSTITUICAO': 'PEC',
    'PEC': 'PEC',
    'PEC - PROPOSTA DE EMENDA CONSTITUCIONAL': 'PEC',
    'PEC PROPOSTA DE EMENDA CONSTITUCIONAL': 'PEC',
    'PROJETO DE DECRETO LEGISLATIVO': 'PDL',
    'PDL': 'PDL',
    'PROJETO DE RESOLUCAO': 'PR',
    'PR': 'PR',
    'PROJETO DE INDICACAO': 'PIL',
    'PIL': 'PIL',
    'PIL - PROJETO DE INDICACAO': 'PIL',
    'PIL PROJETO DE INDICACAO': 'PIL',
    'INDICACAO': 'IND',
    'MOCAO': 'MOC',
    'REQUERIMENTO': 'REQ',
    'REQ.': 'REQ',
    'REQUERIMENTO DE INFORMACAO': 'REQINF',
    'RI': 'REQINF',
    'VETO': 'VETO',
  };
  return mapa[normal] || String(tipo || '').trim().toUpperCase();
}

function radar03DiaUtilAtual() {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
  const d = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w] || 0;
  if (d === 0 || d === 6) return 4;
  return Math.max(0, Math.min(4, d - 1));
}

function radar03AuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = CONTROLE03_BASIC_AUTH || (
    CONTROLE03_API_USER && CONTROLE03_API_PASS
      ? Buffer.from(CONTROLE03_API_USER + ':' + CONTROLE03_API_PASS).toString('base64')
      : ''
  );
  if (token) headers.Authorization = token.startsWith('Basic ') ? token : 'Basic ' + token;
  return headers;
}

function radar03AgruparNovidades(novas) {
  const porTipo = new Map();
  (novas || []).forEach(p => {
    const tipo = radar03TipoControle(p?.tipo || p?.sigla || p?.rotulo || '');
    const partes = radar03NumeroPartes(p);
    if (!tipo || !partes) return;
    const itemCaptado = {
      tipo,
      numeroInt: partes.numeroInt,
      numero: partes.numero,
      ano: partes.ano || String(p?.ano || ''),
      id: String(p?.id || p?.codigo || p?.projeto_id || p?.id_proposicao || ''),
      ementa: String(p?.ementa || p?.resumo || p?.titulo || '').trim(),
      link: String(p?.link || p?.url || p?.fonte || p?.projeto_url || '').trim(),
      clienteSugestao: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
      clienteCitado: Array.isArray(p?.clientesCitados) && p.clientesCitados.length > 0,
      clienteCitadoNomes: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
    };
    let atual = porTipo.get(tipo);
    if (!atual) {
      atual = { ...itemCaptado, itens: [] };
      porTipo.set(tipo, atual);
    }
    atual.itens.push(itemCaptado);
    if (partes.numeroInt > atual.numeroInt) {
      atual.numeroInt = partes.numeroInt;
      atual.numero = partes.numero;
      atual.ano = partes.ano || String(p?.ano || '');
      atual.id = itemCaptado.id;
      atual.ementa = itemCaptado.ementa;
      atual.link = itemCaptado.link;
      atual.clienteSugestao = itemCaptado.clienteSugestao;
    }
  });
  return Array.from(porTipo.values()).map(rec => {
    rec.itens.sort((a, b) => a.numeroInt - b.numeroInt);
    return rec;
  });
}

async function sincronizarRadar03(novas) {
  const resumo = radar03AgruparNovidades(novas);
  if (!resumo.length) return;
  try {
    const getResp = await fetch(CONTROLE03_STATE_URL, { headers: radar03AuthHeaders() });
    if (!getResp.ok) throw new Error('GET ' + getResp.status);
    const state = await getResp.json();
    if (!Array.isArray(state.data)) throw new Error('estado central vazio ou inválido');

    const data = state.data;
    let casa = data.find(item => item && item.casa === CASA_RADAR03);
    if (!casa) {
      casa = { casa: CASA_RADAR03, casaId: CASA_RADAR03, regiao: 'Sudeste', responsavel: 'maria', risco: 'media', status: 'A conferir', week: ['off', 'off', 'off', 'off', 'off'], items: [] };
      data.push(casa);
    }
    if (!Array.isArray(casa.items)) casa.items = [];
    if (!Array.isArray(casa.week)) casa.week = ['off', 'off', 'off', 'off', 'off'];
    while (casa.week.length < 5) casa.week.push('off');

    resumo.forEach(rec => {
      const detalhes = [rec];
      const existentesTipo = casa.items.filter(i => radar03TipoControle(i?.tipo || '') === rec.tipo);
      const baseAtual = existentesTipo.reduce((max, i) => {
        const n = Number.parseInt(String(i?.base || i?.mon || 0), 10) || 0;
        return Math.max(max, n);
      }, 0);

      detalhes.forEach(det => {
        let item = casa.items.find(i =>
          (det.id && i?.radar03Id === det.id) ||
          (radar03TipoControle(i?.tipo || '') === det.tipo &&
            Number.parseInt(String(i?.mon || 0), 10) === det.numeroInt &&
            String(i?.link || '') === String(det.link || ''))
        );
        if (!item) {
          item = casa.items.find(i => radar03TipoControle(i?.tipo || '') === det.tipo);
        }
        if (!item) {
          item = { tipo: det.tipo, base: baseAtual, mon: det.numeroInt, radar03Id: det.id || '' };
          casa.items.push(item);
        }

        const base = Number.parseInt(String(item.base || baseAtual || 0), 10) || 0;
        item.tipo = det.tipo;
        item.mon = det.numeroInt;
        item.delta = det.numeroInt === base ? 0 : 1;
        item.sentido = det.numeroInt === base ? 'bate com o controle' : 'captado individualmente na fonte';
        item.fluxo = item.delta ? 'nao_consultado' : (item.fluxo || 'revisado');
        item.ementa = det.ementa || item.ementa || '';
        item.link = det.link || item.link || '';
        item.clienteSugestao = det.clienteSugestao || item.clienteSugestao || '';
        item.clienteCitado = Boolean(det.clienteCitado || item.clienteCitado);
        item.clienteCitadoNomes = det.clienteCitadoNomes || item.clienteCitadoNomes || item.clienteSugestao || '';
        item.radar03Id = det.id || item.radar03Id || '';
        item.listaReal03 = true;
      });
    });

    casa.status = 'Atualizar 03';
    casa.week[radar03DiaUtilAtual()] = 'leva';
    if (!Array.isArray(casa.obs03)) casa.obs03 = [];
    casa.obs03.push({
      tipo: CASA_RADAR03,
      situacao: 'novo',
      label: 'Rodada ALESP sincronizada automaticamente na 03',
      base: resumo.map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
      fonte: 'monitor-proposicoes-sp',
      at: new Date().toISOString(),
    });

    const postResp = await fetch(CONTROLE03_STATE_URL, {
      method: 'POST',
      headers: radar03AuthHeaders(),
      body: JSON.stringify({ data }),
    });
    if (!postResp.ok) throw new Error('POST ' + postResp.status);
    console.log('✅ Radar 03 sincronizado: ' + CASA_RADAR03 + ' · ' + resumo.map(item => item.tipo + ' ' + item.numero + '/' + item.ano).join(' | '));
  } catch (err) {
    console.warn('⚠️ Não foi possível sincronizar o Radar 03 automaticamente: ' + err.message);
  }
}

function radar03ReviewUrl(novas) {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    bloco: radar03AgruparNovidades(novas).map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
    fonte: radar03PrimeiraFonte(novas),
  });
  return `${RADAR03_URL}?${params.toString()}`;
}


function radar03SemNovidadeUrl() {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    situacao: 'sem_novidade',
    fonte: 'monitor-proposicoes',
  });
  return RADAR03_URL + '?' + params.toString();
}

function radar03Escape(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function renderRadar03SemNovidadeEmailButton() {
  return '\n    <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:6px;padding:12px 14px;margin:14px 0;color:#334155;font-size:13px">\n      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Sem novidades</div>\n      <div style="margin-bottom:9px;color:#475569">' + radar03Escape(CASA_RADAR03) + ' · fonte vista sem proposição nova nesta rodada</div>\n      <a href="' + radar03Escape(radar03SemNovidadeUrl()) + '" style="display:inline-block;background:#475569;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Marcar sem novidade na 03</a>\n      <span style="font-size:12px;color:#64748b;margin-left:8px">abre a 03 pronta para fechar o dia</span>\n    </div>\n  ';
}

function renderRadar03EmailButton(novas) {
  const bloco = radar03BlocoEmail(novas);
  if (!bloco) return renderRadar03SemNovidadeEmailButton();
  return `
    <div style="background:#dcfce7;border:2px solid #15803d;border-radius:8px;padding:14px 16px;margin:0 0 16px;color:#14532d;font-size:13px">
      <div style="font-weight:bold;margin-bottom:6px;font-size:15px">Atualizar/Revisar no Radar 03</div>
      <div style="margin-bottom:10px;color:#14532d;font-weight:bold">${radar03Escape(CASA_RADAR03)} · ${radar03Escape(bloco)}</div>
      <a href="${radar03Escape(radar03ReviewUrl(novas))}" style="display:inline-block;background:#15803d;color:white;text-decoration:none;border-radius:6px;padding:10px 14px;font-size:13px;font-weight:bold">Abrir 03 preenchida</a>
      <span style="display:inline-block;font-size:12px;color:#334155;margin-left:8px">confirmação humana antes de salvar</span>
    </div>
  `;
}


async function enviarEmail(novas, eventosAgenda = []) {
  if (CONTROLE03_FORCE_LATEST) {
    console.log('📌 Modo Controle 03: email de novidades não enviado.');
    return;
  }

  anotarClientesCitados(novas);
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

  const linhas = Object.keys(porTipo).sort(compararTiposEmail).map(tipo => {
    const header = `<tr><td colspan="4" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#1a3a5c;font-size:13px;border-top:2px solid #1a3a5c">${tipo} — ${porTipo[tipo].length} proposição(ões)</td></tr>`;
    const rows = porTipo[tipo]
      .sort((a, b) => (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0))
      .map(p => `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">
          <a href="${p.link}" style="color:#1a3a5c;font-weight:bold;text-decoration:none">${p.numero}/${p.ano}</a>
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;color:#555;white-space:nowrap">${p.data}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px">${renderizarEmentaCliente(p)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">
          <a href="${p.link}" style="font-size:11px;color:#1a7bc4;text-decoration:none">🔗 ver</a>
        </td>
      </tr>`).join('');
    return header + rows;
  }).join('');

  const html = `
      ${renderRadar03EmailButton(novas)}
    <div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">
      <h2 style="color:#1a3a5c;border-bottom:2px solid #1a3a5c;padding-bottom:8px">
        🏛️ Assembleia Legislativa de São Paulo — ${novas.length} nova(s) proposição(ões)
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
      ${montarSecaoAgenda(eventosAgenda)}
      <p style="margin-top:20px;font-size:12px;color:#999">
        Fonte: <a href="https://www.al.sp.gov.br/dados-abertos/">Portal de Dados Abertos da Assembleia Legislativa de São Paulo</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor São Paulo" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: assuntoEmailClienteCitado(novas, `🏛️ São Paulo: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`),
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

  const naturezas = await carregarNaturezas();
  let proposicoesZip = [];
  try {
    const zipBuffer = await baixarBuffer(URL_PROPOSITURAS, 120000);
    const xmlStr = extrairXmlDoZip(zipBuffer);
    proposicoesZip = parsearProposicoes(xmlStr, naturezas, ano);
  } catch (err) {
    console.warn('⚠️ Falha ao baixar/ler ZIP de proposituras; seguindo com busca pública: ' + err.message);
  }

  const proposicoesListagem = await carregarProposicoesListagem(ano);
  const proposicoes = mesclarProposicoes([proposicoesZip, proposicoesListagem]);
  console.log('📊 Total consolidado ZIP + busca pública: ' + proposicoes.length);

  if (proposicoes.length === 0) {
    console.log('⚠️ Nenhuma proposição encontrada. Verifique o dump 🔬 acima.');
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
    process.exit(0);
  }

  const novas = proposicoes.filter(p => !idsVistos.has(p.id));
  console.log(`🆕 Proposições novas: ${novas.length}`);

  if (novas.length > 0) {
    const agendaAlesp = await carregarAgendaAlesp();
    anotarClientesCitados(novas);
    await sincronizarRadar03(novas);
    await enviarEmail(novas, agendaAlesp);
    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
  }

  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();

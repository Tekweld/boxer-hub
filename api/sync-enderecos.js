// Sincroniza enderecos do Zen para comercial.hub_enderecos.
//
// Por que endpoint separado, e nao mais uma etapa do sync-zen-clientes:
// aquele sync varre TODAS as pessoas dos 3 canais no Zen antes de chegar em
// qualquer outra coisa, e ja estoura o maxDuration de 60s sozinho -- a etapa
// de endereco nunca era alcancada. Aqui a varredura e dirigida pela lista de
// clientes que o Hub JA tem (hub_clientes.erp_cliente_id), paginada, entao da
// pra processar em fatias e retomar de onde parou.
//
// Fonte dos dados (duas, e a principal e barata):
//   1. O proprio `Person` do Zen carrega o endereco completo
//      (zipcode/street/number/complement/district/city) -> tipo 'principal'
//   2. `/catalog/person/personAddress` traz os adicionais -> tipo 'entrega'
//
// Na base real o personAddress costuma ser copia identica do endereco do
// Person (id = id do Person + 1, sugerindo criacao automatica), entao ha
// deduplicacao por assinatura -- senao todo cliente apareceria com dois
// enderecos iguais na tela de cadastro.

const { zenGet } = require('./_zen');

const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';

// Para em ~45s e devolve `proximo_offset`. A funcao tem 60s: melhor devolver
// progresso e o ponto de retomada do que ser morta pelo gateway sem resposta.
const ORCAMENTO_MS = 45000;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });

  const hubH = (method) => ({
    'Content-Type': 'application/json',
    'apikey': SB_SERVICE,
    'Authorization': 'Bearer ' + SB_SERVICE,
    'Accept-Profile': 'comercial',
    'Content-Profile': 'comercial',
    'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
  });

  const cronSecret = req.headers['x-cron-secret'];
  const authHeader = req.headers.authorization;
  const viaVercelCron = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;

  if (cronSecret) {
    if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'CRON_SECRET invalido' });
    }
  } else if (viaVercelCron) {
    // autorizado pelo agendador do Vercel
  } else if (authHeader) {
    const userRes = await fetch(HUB_URL + '/auth/v1/user', {
      headers: { 'Authorization': authHeader, 'apikey': SB_SERVICE }
    });
    const caller = await userRes.json();
    if (!caller?.id) return res.status(401).json({ error: 'Token invalido' });
    const perfilRes = await fetch(
      HUB_URL + '/rest/v1/hub_perfis?user_id=eq.' + caller.id + '&ativo=eq.true&select=role',
      { headers: hubH('GET') });
    const perfis = await perfilRes.json();
    if (!perfis?.[0] || !['admin', 'manager'].includes(perfis[0].role)) {
      return res.status(403).json({ error: 'Apenas admin ou manager pode sincronizar' });
    }
  } else {
    return res.status(401).json({ error: 'Autenticacao necessaria' });
  }

  const t0 = Date.now();
  const offset = Math.max(0, parseInt(req.query?.offset, 10) || 0);
  const dryRun = req.query?.dry === '1';
  const passo = 100; // clientes por rodada de consulta ao Zen

  const r = {
    offset_inicial: offset, clientes_lidos: 0, pessoas_no_zen: 0,
    adicionais_no_zen: 0, a_gravar: 0, gravados: 0,
    sem_endereco_no_zen: 0, erros: [], dry_run: dryRun
  };

  try {
    let cursor = offset;
    let acabou = false;

    while (Date.now() - t0 < ORCAMENTO_MS) {
      const cRes = await fetch(HUB_URL +
        '/rest/v1/hub_clientes?erp_cliente_id=not.is.null&ativo=eq.true' +
        '&select=id,erp_cliente_id&order=erp_cliente_id.asc' +
        '&offset=' + cursor + '&limit=' + passo, { headers: hubH('GET') });
      if (!cRes.ok) {
        r.erros.push({ etapa: 'ler_clientes', offset: cursor, status: cRes.status });
        break;
      }
      const clientes = await cRes.json();
      if (!clientes.length) { acabou = true; break; }

      r.clientes_lidos += clientes.length;
      cursor += clientes.length;

      const idHub = {};
      clientes.forEach(c => { idHub[String(c.erp_cliente_id)] = c.id; });
      const ids = Object.keys(idHub);

      const linhas = [];
      const vistos = {};
      const assinatura = o => [o.zipcode, o.street, o.number, o.complement]
        .map(v => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ')).join('|');

      const monta = (clienteId, erpId, tipo, o, padrao) => {
        if (!o.zipcode && !o.street) return;
        const set = vistos[clienteId] || (vistos[clienteId] = new Set());
        const sig = assinatura(o);
        if (set.has(sig)) return;
        set.add(sig);
        linhas.push({
          cliente_id: clienteId, erp_endereco_id: erpId, tipo,
          cep: o.zipcode || null,
          logradouro: o.street || null,
          numero: o.number != null ? String(o.number) : null,
          complemento: o.complement || null,
          bairro: o.district || null,
          cidade: o.city?.name || null,
          uf: o.city?.state?.code || null,
          padrao, ativo: true
        });
      };

      // Person (endereco principal) — RSQL aceita OR com virgula em parenteses
      try {
        const pessoas = await zenGet('/catalog/person/person', {
          q: '(' + ids.map(id => 'id==' + id).join(',') + ')', max: passo, limite: passo
        });
        r.pessoas_no_zen += pessoas.length;
        pessoas.forEach(p => {
          const dono = idHub[String(p.id)];
          if (!dono) return;
          const antes = linhas.length;
          monta(dono, 'person:' + p.id, 'principal', p, true);
          if (linhas.length === antes) r.sem_endereco_no_zen++;
        });
      } catch (e) {
        r.erros.push({ etapa: 'person', offset: cursor, detalhe: e.message.slice(0, 150) });
      }

      // personAddress (adicionais)
      try {
        const adicionais = await zenGet('/catalog/person/personAddress', {
          q: '(' + ids.map(id => 'person.id==' + id).join(',') + ')', max: 300, limite: 1000
        });
        r.adicionais_no_zen += adicionais.length;
        adicionais.forEach(a => {
          const dono = idHub[String(a.person?.id ?? a.person)];
          if (dono) monta(dono, String(a.id), 'entrega', a, false);
        });
      } catch (e) {
        r.erros.push({ etapa: 'personAddress', offset: cursor, detalhe: e.message.slice(0, 150) });
      }

      r.a_gravar += linhas.length;

      if (!dryRun && linhas.length) {
        for (let i = 0; i < linhas.length; i += 200) {
          const lote = linhas.slice(i, i + 200);
          const g = await fetch(HUB_URL + '/rest/v1/hub_enderecos?on_conflict=erp_endereco_id', {
            method: 'POST',
            headers: { ...hubH('POST'), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(lote)
          });
          if (!g.ok) {
            r.erros.push({ etapa: 'gravar', offset: cursor, status: g.status, detalhe: (await g.text()).slice(0, 200) });
            continue;
          }
          r.gravados += lote.length;
        }
      }
    }

    r.duracao_ms = Date.now() - t0;
    r.concluido = acabou;
    if (!acabou) r.proximo_offset = cursor;

    console.log('[ENDERECOS]', JSON.stringify(r));
    return res.status(200).json({ ok: r.erros.length === 0, ...r });

  } catch (e) {
    console.error('[ENDERECOS] erro:', e.message);
    return res.status(500).json({ ok: false, erro: e.message, ...r });
  }
};

// Roteador de upload -- funde `upload-foto` e `upload-documento-cadastro` num
// endpoint so, para caber no teto de 12 Serverless Functions do plano Hobby.
//
// A fusao e superficial DE PROPOSITO: as duas rotas nao compartilham logica,
// so o casco (JWT parse, hubH). Cada `kind` tem seu proprio auth e seu proprio
// bucket, porque juntar as duas coisas seria erro de seguranca:
//
//   kind='foto'                 -> bucket publico  `hub-fotos`, auth admin/manager/analyst
//   kind='documento-cadastro'   -> bucket privado  `hub-documentos-cadastrais`, auth = dono do cadastro
//
// A escolha de qual rota rodar acontece ANTES de qualquer resolucao de bucket
// ou permissao; nao ha caminho que caia na rota errada por parametro faltando.

const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token necessario' });

  // O identificador da rota vem no body (a semantica dos payloads era
  // diferente antes da fusao, entao explicito e melhor que inferir).
  const kind = req.body?.kind;
  if (kind === 'foto') return handlerFoto(req, res, SB_SERVICE, authHeader);
  if (kind === 'documento-cadastro') return handlerDocCadastro(req, res, SB_SERVICE, authHeader);
  return res.status(400).json({ error: 'kind obrigatorio: "foto" ou "documento-cadastro"' });
};

function hubH(SB_SERVICE, method) {
  return {
    'Content-Type': 'application/json',
    'apikey': SB_SERVICE,
    'Authorization': 'Bearer ' + SB_SERVICE,
    'Accept-Profile': 'comercial',
    'Content-Profile': 'comercial',
    'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
  };
}

// ============================================================
// FOTO -- bucket publico, admin/manager/analyst
// ============================================================
async function handlerFoto(req, res, SB_SERVICE, authHeader) {
  const BUCKET = 'hub-fotos';

  const userRes = await fetch(HUB_URL + '/auth/v1/user', {
    headers: { 'Authorization': authHeader, 'apikey': SB_SERVICE }
  });
  const caller = await userRes.json();
  if (!caller?.id) return res.status(401).json({ error: 'Token invalido' });

  const perfilRes = await fetch(
    HUB_URL + '/rest/v1/hub_perfis?user_id=eq.' + caller.id + '&ativo=eq.true&select=role',
    { headers: hubH(SB_SERVICE, 'GET') }
  );
  const perfis = await perfilRes.json();
  if (!perfis?.[0] || !['admin', 'manager', 'analyst'].includes(perfis[0].role)) {
    return res.status(403).json({ error: 'Sem permissao' });
  }

  const { action, anexo_id, produto_id, filename, base64, content_type } = req.body;

  try {
    if (action === 'delete') {
      if (!anexo_id) return res.status(400).json({ error: 'anexo_id obrigatorio' });

      const getRes = await fetch(
        HUB_URL + '/rest/v1/hub_produto_anexos?id=eq.' + anexo_id + '&select=storage_path',
        { headers: hubH(SB_SERVICE, 'GET') }
      );
      const anexos = await getRes.json();

      if (anexos?.[0]?.storage_path?.includes('/' + BUCKET + '/')) {
        const storagePath = anexos[0].storage_path.split('/' + BUCKET + '/')[1];
        if (storagePath) {
          await fetch(HUB_URL + '/storage/v1/object/' + BUCKET + '/' + storagePath, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + SB_SERVICE, 'apikey': SB_SERVICE }
          }).catch(() => {});
        }
      }

      await fetch(HUB_URL + '/rest/v1/hub_produto_anexos?id=eq.' + anexo_id, {
        method: 'DELETE', headers: hubH(SB_SERVICE, 'DELETE')
      });

      return res.status(200).json({ ok: true });
    }

    if (!produto_id || !base64 || !filename) {
      return res.status(400).json({ error: 'produto_id, filename e base64 obrigatorios' });
    }

    // Ensure bucket exists (idempotente)
    await fetch(HUB_URL + '/storage/v1/bucket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SB_SERVICE, 'apikey': SB_SERVICE },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true })
    }).catch(() => {});

    const buffer = Buffer.from(base64, 'base64');
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = produto_id + '/' + Date.now() + '-' + safeName;

    const uploadRes = await fetch(HUB_URL + '/storage/v1/object/' + BUCKET + '/' + storagePath, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + SB_SERVICE,
        'apikey': SB_SERVICE,
        'Content-Type': content_type || 'image/jpeg',
        'x-upsert': 'true'
      },
      body: buffer
    });

    if (!uploadRes.ok) return res.status(500).json({ error: 'Erro no upload: ' + await uploadRes.text() });

    const publicUrl = HUB_URL + '/storage/v1/object/public/' + BUCKET + '/' + storagePath;

    const anexoRes = await fetch(HUB_URL + '/rest/v1/hub_produto_anexos', {
      method: 'POST',
      headers: hubH(SB_SERVICE, 'POST'),
      body: JSON.stringify({
        produto_id, tipo: 'foto', storage_path: publicUrl,
        nome: safeName, alt_text: safeName.replace(/\.[^.]+$/, ''), ordem: 5
      })
    });
    if (!anexoRes.ok) return res.status(500).json({ error: 'Erro ao criar anexo: ' + await anexoRes.text() });

    const anexo = await anexoRes.json();
    return res.status(200).json({ ok: true, anexo: anexo[0], url: publicUrl });

  } catch (e) {
    console.error('[upload/foto] erro:', e);
    return res.status(500).json({ error: e.message });
  }
}

// ============================================================
// DOCUMENTO CADASTRO -- bucket PRIVADO, dono do cadastro so pra si
// ============================================================
async function handlerDocCadastro(req, res, SB_SERVICE, authHeader) {
  const BUCKET = 'hub-documentos-cadastrais';

  try {
    const userRes = await fetch(HUB_URL + '/auth/v1/user', {
      headers: { 'Authorization': authHeader, 'apikey': SB_SERVICE }
    });
    const caller = await userRes.json();
    if (!caller?.id) return res.status(401).json({ error: 'Token invalido' });

    const perfilRes = await fetch(
      HUB_URL + '/rest/v1/hub_perfis?user_id=eq.' + caller.id + '&ativo=eq.true&select=tipo,cliente_id',
      { headers: hubH(SB_SERVICE, 'GET') }
    );
    const perfis = await perfilRes.json();
    const perfil = perfis?.[0];

    // Regra que sobrevive a fusao: aqui, so o proprio cliente sobe documento
    // do proprio cadastro. Upload por terceiros (rep, admin) exigiria fluxo
    // deliberado, com log de acao alheia -- nao tem hoje.
    if (!perfil || perfil.tipo !== 'cliente' || !perfil.cliente_id) {
      return res.status(403).json({ error: 'Apenas o proprio cliente pode enviar documento do seu cadastro' });
    }

    const { tipo, filename, base64, content_type } = req.body;
    if (!tipo || !filename || !base64) {
      return res.status(400).json({ error: 'tipo, filename e base64 sao obrigatorios' });
    }

    // Bucket PRIVADO (public:false) -- ninguem le sem passar pela API
    await fetch(HUB_URL + '/storage/v1/bucket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SB_SERVICE, 'apikey': SB_SERVICE },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false })
    }).catch(() => {});

    const buffer = Buffer.from(base64, 'base64');
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = perfil.cliente_id + '/' + Date.now() + '-' + safeName;

    const uploadRes = await fetch(HUB_URL + '/storage/v1/object/' + BUCKET + '/' + storagePath, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + SB_SERVICE,
        'apikey': SB_SERVICE,
        'Content-Type': content_type || 'application/octet-stream',
        'x-upsert': 'true'
      },
      body: buffer
    });
    if (!uploadRes.ok) return res.status(500).json({ error: 'Erro no upload: ' + await uploadRes.text() });

    const docRes = await fetch(HUB_URL + '/rest/v1/hub_documentos_cadastrais', {
      method: 'POST',
      headers: hubH(SB_SERVICE, 'POST'),
      body: JSON.stringify({
        cliente_id: perfil.cliente_id, tipo, nome: safeName,
        storage_path: BUCKET + '/' + storagePath, status: 'pendente'
      })
    });
    if (!docRes.ok) return res.status(500).json({ error: 'Erro ao registrar documento: ' + await docRes.text() });

    const doc = await docRes.json();
    return res.status(200).json({ ok: true, documento: doc[0] });

  } catch (e) {
    console.error('[upload/documento-cadastro] erro:', e);
    return res.status(500).json({ error: e.message });
  }
}

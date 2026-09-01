const { zenGet } = require('./_zen');

const SB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });

  const { token, senha } = req.body || {};
  if (!token || !senha) return res.status(400).json({ error: 'Token e senha obrigatorios' });
  if (senha.length < 6) return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });

  const sbHeaders = (method) => ({
    'Content-Type': 'application/json',
    'apikey': SB_SERVICE,
    'Authorization': 'Bearer ' + SB_SERVICE,
    'Accept-Profile': 'comercial',
    'Content-Profile': 'comercial',
    'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
  });

  try {
    // 1 — Buscar convite
    const convRes = await fetch(
      SB_URL + '/rest/v1/hub_convites?token=eq.' + token + '&status=eq.pendente&select=*',
      { headers: sbHeaders('GET') }
    );
    const convites = await convRes.json();
    if (!convites?.[0]) return res.status(400).json({ error: 'Convite invalido, expirado ou ja utilizado' });
    const convite = convites[0];

    if (new Date(convite.expira_em) < new Date()) {
      await fetch(SB_URL + '/rest/v1/hub_convites?id=eq.' + convite.id, {
        method: 'PATCH', headers: sbHeaders('PATCH'),
        body: JSON.stringify({ status: 'expirado' })
      });
      return res.status(400).json({ error: 'Este convite expirou. Solicite um novo.' });
    }

    // 2 — Buscar cliente
    const cliRes = await fetch(
      SB_URL + '/rest/v1/hub_clientes?id=eq.' + convite.cliente_id + '&ativo=eq.true&select=*',
      { headers: sbHeaders('GET') }
    );
    const clientes = await cliRes.json();
    if (!clientes?.[0]) return res.status(400).json({ error: 'Cliente nao encontrado' });
    let cliente = clientes[0];

    // 2b — Cliente convidado (existente no Zen) pode nunca ter passado por
    // api/ativar.js, que e o unico lugar que grava limite_credito hoje --
    // sem isso ele nunca consegue submeter pedido. Busca pontual (1 cliente
    // so, rapido) no momento da ativacao, em vez de depender do sync em lote
    // rodar de novo. Best-effort: nunca bloqueia o aceite do convite.
    if ((!cliente.limite_credito || +cliente.limite_credito === 0) && cliente.erp_cliente_id) {
      try {
        const itens = await zenGet('/financial/credit/creditLineItem', {
          q: `person.id==${cliente.erp_cliente_id}`, max: 20, limite: 20
        });
        const limite = itens.reduce((s, it) => s + (+it.value || 0), 0);
        if (limite > 0) {
          await fetch(SB_URL + '/rest/v1/hub_clientes?id=eq.' + cliente.id, {
            method: 'PATCH', headers: sbHeaders('PATCH'),
            body: JSON.stringify({ limite_credito: limite, limite_disponivel: limite })
          });
          cliente = { ...cliente, limite_credito: limite, limite_disponivel: limite };
        }
      } catch (e) {
        console.warn('[convite] falha ao buscar limite de credito no Zen:', e.message.slice(0, 150));
      }
    }

    // 3 — Verificar se email ja tem usuario
    const existRes = await fetch(SB_URL + '/auth/v1/admin/users?page=1&per_page=1', {
      headers: { 'apikey': SB_SERVICE, 'Authorization': 'Bearer ' + SB_SERVICE }
    });

    // 4 — Criar usuario Supabase Auth
    const createUserRes = await fetch(SB_URL + '/auth/v1/admin/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SB_SERVICE,
        'Authorization': 'Bearer ' + SB_SERVICE
      },
      body: JSON.stringify({
        email: convite.email,
        password: senha,
        email_confirm: true,
        user_metadata: {
          nome: cliente.razao_social,
          tipo: 'cliente'
        }
      })
    });
    const newUser = await createUserRes.json();
    if (!newUser?.id) {
      const errMsg = newUser?.msg || newUser?.message || JSON.stringify(newUser);
      if (errMsg.includes('already been registered') || errMsg.includes('already exists')) {
        return res.status(400).json({ error: 'Este email ja possui uma conta. Use a tela de login.' });
      }
      return res.status(500).json({ error: 'Erro ao criar usuario: ' + errMsg });
    }

    // 5 — Criar hub_perfis
    await fetch(SB_URL + '/rest/v1/hub_perfis', {
      method: 'POST', headers: sbHeaders('POST'),
      body: JSON.stringify({
        user_id: newUser.id,
        tipo: 'cliente',
        role: 'dealer',
        nome: cliente.nome_fantasia || cliente.razao_social,
        email: convite.email,
        cliente_id: convite.cliente_id,
        ativo: true
      })
    });

    // 6 — Atualizar convite
    await fetch(SB_URL + '/rest/v1/hub_convites?id=eq.' + convite.id, {
      method: 'PATCH', headers: sbHeaders('PATCH'),
      body: JSON.stringify({
        status: 'aceito',
        user_id: newUser.id,
        aceito_em: new Date().toISOString()
      })
    });

    // 7 — Log
    await fetch(SB_URL + '/rest/v1/hub_log_alteracoes', {
      method: 'POST', headers: sbHeaders('POST'),
      body: JSON.stringify({
        usuario_id: newUser.id,
        usuario_email: convite.email,
        tabela_ref: 'hub_convites',
        registro_id: convite.id,
        campo: 'status',
        valor_anterior: 'pendente',
        valor_novo: 'aceito',
        acao: 'convite_aceito'
      })
    });

    return res.status(200).json({
      ok: true,
      razao_social: cliente.razao_social,
      email: convite.email
    });

  } catch (e) {
    console.error('Erro ao aceitar convite:', e);
    return res.status(500).json({ error: e.message });
  }
};

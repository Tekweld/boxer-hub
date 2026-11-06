const RESEND_URL = 'https://api.resend.com/emails';
const FROM_DEFAULT = 'Boxer Hub <noreply@boxersoldas.com.br>';
const HUB_URL = 'https://hub.boxersoldas.com.br';

module.exports = async function handler(req, res) {
  // CORS: essa funcao passou a ser chamada tambem de fora do Hub
  // (app.boxersoldas.com.br — propostas/admin da tabela de precos), pra
  // avisar por email quando uma senha e alterada. Chamadas same-origin
  // (onboarding/admin do proprio Hub) nao sao afetadas por isso.
  res.setHeader('Access-Control-Allow-Origin', 'https://app.boxersoldas.com.br');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) {
    console.warn('RESEND_API_KEY nao configurada — email nao enviado');
    return res.status(200).json({ ok: true, enviado: false, motivo: 'RESEND_API_KEY nao configurada' });
  }

  const { tipo, dados } = req.body || {};
  if (!tipo || !dados) return res.status(400).json({ error: 'tipo e dados obrigatorios' });

  // Avisa a equipe interna (area_responsavel do canal de resolucao + admin/
  // manager) quando um cadastro de onboarding entra numa etapa que depende
  // de alguem de la agir -- achado em 2026-11-06: ate aqui so existia um
  // email fixo pro Andre em "novo cadastro"; ninguem era avisado nas etapas
  // seguintes (ADM Vendas aprovar, financeiro analisar/aprovar credito).
  // Rota separada da logica normal de buildEmail porque precisa consultar
  // hub_perfis antes de montar o email (lista de destinatarios dinamica).
  if (tipo === 'onboarding_equipe') {
    try {
      return res.status(200).json(await notificarEquipeOnboarding(dados));
    } catch (e) {
      console.error('Erro ao notificar equipe onboarding:', e);
      return res.status(200).json({ ok: true, enviado: false, motivo: e.message });
    }
  }

  try {
    const email = buildEmail(tipo, dados);
    if (!email) return res.status(400).json({ error: 'Tipo de email desconhecido: ' + tipo });

    const r = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + RESEND_KEY
      },
      body: JSON.stringify({
        from: email.from || FROM_DEFAULT,
        to: Array.isArray(email.to) ? email.to : [email.to],
        subject: email.subject,
        html: wrapHtml(email.subject, email.body)
      })
    });

    const result = await r.json();
    if (!r.ok) {
      console.error('Resend error:', result);
      return res.status(200).json({ ok: true, enviado: false, motivo: result.message || 'Erro Resend' });
    }

    return res.status(200).json({ ok: true, enviado: true, id: result.id });
  } catch (e) {
    console.error('Erro ao enviar email:', e);
    return res.status(200).json({ ok: true, enviado: false, motivo: e.message });
  }
};

function buildEmail(tipo, d) {
  switch (tipo) {

    case 'onboarding_novo':
      return {
        to: 'andre.coelho@boxersoldas.com.br',
        subject: 'Novo cadastro de revendedor — ' + (d.razao_social || 'Sem nome'),
        body: `
          <p>Um novo cadastro de revendedor foi submetido no Boxer Hub.</p>
          ${infoBox([
            ['Razao Social', d.razao_social],
            ['CNPJ', d.cnpj],
            ['Nome Fantasia', d.nome_fantasia],
            ['Email', d.contato_email],
            ['Telefone', d.contato_telefone],
            ['Classificacao', d.classificacao],
            ['Regiao', d.regiao]
          ])}
          <p>Acesse o painel Admin para revisar e avancar o cadastro:</p>
          ${btnLink(HUB_URL + '/admin.html', 'Ver no Admin')}
        `
      };

    case 'convite':
      return {
        to: d.email,
        subject: 'Convite para o Boxer Hub — Boxer Soldas',
        body: `
          <p>Voce foi convidado a acessar o <strong>Boxer Hub</strong>, o portal de revendedores da Boxer Soldas.</p>
          ${infoBox([
            ['Empresa', d.razao_social],
            ['CNPJ', d.cnpj]
          ])}
          <p>Clique no botao abaixo para criar sua senha e ativar sua conta. O link e valido por 7 dias.</p>
          ${btnLink(d.link, 'Ativar Minha Conta')}
          <p style="font-size:12px;color:#718096;margin-top:16px">Se voce nao solicitou este acesso, ignore este email.</p>
        `
      };

    case 'rejeicao':
      return {
        to: d.email,
        subject: 'Cadastro Boxer Hub — Pendencias para correcao',
        body: `
          <p>Seu cadastro no <strong>Boxer Hub</strong> foi analisado pela equipe comercial da Boxer Soldas e precisa de ajustes antes de prosseguir.</p>
          ${infoBox([
            ['Empresa', d.razao_social],
            ['CNPJ', d.cnpj],
            ['Etapa', d.etapa]
          ])}
          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:16px 0">
            <p style="font-size:13px;font-weight:600;color:#991b1b;margin:0 0 8px">Pontos a corrigir:</p>
            <div style="font-size:13px;color:#991b1b;white-space:pre-line">${d.motivo}</div>
          </div>
          <p>Por favor, entre em contato com a equipe comercial ou submeta um novo cadastro com as correcoes indicadas.</p>
          ${btnLink(HUB_URL + '/onboarding.html', 'Refazer Cadastro')}
          <p style="font-size:12px;color:#718096;margin-top:16px">Em caso de duvidas, entre em contato pelo email comercial@boxersoldas.com.br.</p>
        `
      };

    case 'ativacao':
      return {
        to: d.email,
        subject: 'Sua conta no Boxer Hub foi ativada!',
        body: `
          <p>Bem-vindo ao <strong>Boxer Hub</strong>! Sua conta foi ativada com sucesso.</p>
          ${infoBox([
            ['Empresa', d.razao_social],
            ['Login', d.email],
            ['Senha temporaria', '<code style="font-size:16px;color:#e30613;background:#fee2e2;padding:2px 8px;border-radius:4px">' + d.senha_temp + '</code>'],
            ['Limite de credito', d.limite]
          ])}
          <p><strong>Recomendamos trocar a senha no primeiro acesso.</strong></p>
          ${btnLink(HUB_URL, 'Acessar o Boxer Hub')}
        `
      };

    case 'acesso_liberado':
      return {
        to: d.email,
        from: 'Boxer Tabela de Preços <noreply@boxersoldas.com.br>',
        subject: 'Seu acesso à Tabela de Preços Boxer foi liberado',
        body: `
          <p>Olá${d.nome ? ', <strong>' + d.nome + '</strong>' : ''}! Seu acesso à <strong>Tabela de Preços Boxer</strong> foi liberado${d.validade ? ' até <strong>' + d.validade + '</strong>' : ''}.</p>
          <p style="font-size:13px;color:#4a5568">Para entrar, informe este email na tela de acesso e digite o código que enviaremos para você. Não há senha para lembrar.</p>
          ${btnLink(d.link || 'https://app.boxersoldas.com.br/tabela-teste.html', 'Acessar a tabela')}
        `
      };

    // Avisa o representante quando o cadastro que ELE abriu (via
    // cadastro-representante.html) avanca, e reprova ou e cancelado --
    // pedido do Andre, 2026-11-06: "toda aprovacao ou reprovacao tem que ir
    // pra ele tambem". So dispara quando o cadastro foi criado por
    // representante (criado_por_tipo='representante'); cadastro aberto pela
    // propria revenda continua indo so pra ela (sem mudanca).
    case 'onboarding_rep_update':
      return {
        to: d.email,
        subject: 'Cadastro ' + d.razao_social + ' — ' + d.titulo,
        body: `
          <p>Ola${d.nome_representante ? ', <strong>' + d.nome_representante + '</strong>' : ''}! Atualizacao no cadastro que voce abriu no Boxer Hub.</p>
          ${infoBox([
            ['Empresa', d.razao_social],
            ['CNPJ', d.cnpj],
            ['Status', d.titulo]
          ])}
          <div style="background:${d.cor === 'erro' ? '#fef2f2' : '#eef3ff'};border:1px solid ${d.cor === 'erro' ? '#fecaca' : '#c3d3f5'};border-radius:8px;padding:16px;margin:16px 0">
            <p style="font-size:13px;color:${d.cor === 'erro' ? '#991b1b' : '#1d327b'};margin:0;white-space:pre-line">${d.mensagem}</p>
          </div>
          ${btnLink(HUB_URL + '/pedidos.html', 'Acompanhar no Hub')}
        `
      };

    case 'senha_alterada':
      return {
        to: d.email,
        from: 'Boxer ' + (d.sistema || 'Hub') + ' <noreply@boxersoldas.com.br>',
        subject: 'Sua senha Boxer foi alterada',
        body: `
          <p>A senha da sua conta <strong>${d.email}</strong> foi alterada${d.sistema ? ' via ' + d.sistema : ''}${d.hora ? ' em ' + d.hora : ''}.</p>
          <p style="font-size:13px;color:#718096">Essa senha e a mesma usada em todos os sistemas Boxer que compartilham este login (Hub, admin da tabela de precos, propostas).</p>
          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:16px 0">
            <p style="font-size:13px;color:#991b1b;margin:0"><strong>Nao foi voce?</strong> Entre em contato com o administrador imediatamente.</p>
          </div>
        `
      };

    default:
      return null;
  }
}

// Avisa quem precisa agir num cadastro de onboarding: funcionarios da
// `area` informada (vendas_adm/financeiro/etc, mesmo conceito do canal de
// resolucao) + admin/manager (enxergam tudo) + Andre sempre, como rede de
// seguranca (hoje nenhum hub_perfis tem email dele -- sem isso ele para de
// ser avisado assim que a rota passa a depender so de area/role).
const SB_URL_INT = 'https://bmepxcnrsofofoswubuu.supabase.co';
const ANDRE_FALLBACK = 'andre.coelho@boxersoldas.com.br';

async function notificarEquipeOnboarding(d) {
  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return { ok: true, enviado: false, motivo: 'SUPABASE_SERVICE_KEY nao configurada' };

  const H = {
    'Content-Type': 'application/json', apikey: SB_SERVICE, Authorization: 'Bearer ' + SB_SERVICE,
    'Accept-Profile': 'comercial', 'Content-Profile': 'comercial'
  };

  const filtroOr = d.area
    ? 'or=(area.eq.' + encodeURIComponent(d.area) + ',role.in.(admin,manager))'
    : 'role=in.(admin,manager)';
  const perfis = await fetch(
    SB_URL_INT + '/rest/v1/hub_perfis?ativo=eq.true&tipo=neq.cliente&' + filtroOr + '&select=user_id,email,nome',
    { headers: H }
  ).then(r => r.ok ? r.json() : []).catch(() => []);

  const emails = new Set([ANDRE_FALLBACK]);
  for (const p of perfis) if (p.email) emails.add(p.email);

  // Notificacao dentro do Hub so pra quem tem login de fato (user_id) --
  // o fallback do Andre e so por email, nao gera notificacao fantasma se
  // ele nao tiver hub_perfis.
  const comLogin = perfis.filter(p => p.user_id);
  if (comLogin.length) {
    await fetch(SB_URL_INT + '/rest/v1/hub_notificacoes', {
      method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify(comLogin.map(p => ({
        usuario_id: p.user_id, tipo: 'aprovacao_pendente', titulo: d.titulo,
        mensagem: (d.razao_social || '') + ' — ' + d.mensagem,
        referencia_tipo: 'onboarding', referencia_id: d.onboarding_id || null, lida: false
      })))
    }).catch(() => {});
  }

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return { ok: true, enviado: false, motivo: 'RESEND_API_KEY nao configurada', notificados_hub: comLogin.length };

  const subject = 'Onboarding aguardando acao — ' + (d.razao_social || 'cadastro') + ' — ' + d.titulo;
  const body = `
    <p>Um cadastro de revendedor no <strong>Boxer Hub</strong> esta aguardando a sua acao.</p>
    ${infoBox([
      ['Empresa', d.razao_social],
      ['CNPJ', d.cnpj],
      ['Etapa', d.etapa],
      ['Status', d.titulo]
    ])}
    ${d.mensagem ? '<p style="font-size:13px;color:#4a5568">' + d.mensagem + '</p>' : ''}
    ${btnLink(HUB_URL + '/admin.html', 'Abrir no Admin')}
  `;

  const r = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_KEY },
    body: JSON.stringify({ from: FROM_DEFAULT, to: Array.from(emails), subject, html: wrapHtml(subject, body) })
  });
  const result = await r.json();
  if (!r.ok) return { ok: true, enviado: false, motivo: result.message || 'Erro Resend', notificados_hub: comLogin.length };
  return { ok: true, enviado: true, id: result.id, notificados_email: emails.size, notificados_hub: comLogin.length };
}

function infoBox(rows) {
  const trs = rows
    .filter(([, v]) => v)
    .map(([label, value]) => `<tr><td style="padding:6px 12px;font-size:13px;color:#718096;border-bottom:1px solid #e2e8f0">${label}</td><td style="padding:6px 12px;font-size:13px;color:#1a202c;font-weight:500;border-bottom:1px solid #e2e8f0">${value}</td></tr>`)
    .join('');
  return `<table style="width:100%;border-collapse:collapse;background:#f7fafc;border:1px solid #e2e8f0;border-radius:8px;margin:16px 0">${trs}</table>`;
}

function btnLink(url, label) {
  return `<div style="text-align:center;margin:24px 0"><a href="${url}" style="display:inline-block;padding:12px 28px;background:#1d327b;color:#fff;text-decoration:none;border-radius:8px;font-family:Arial,sans-serif;font-size:14px;font-weight:600">${label}</a></div>`;
}

function wrapHtml(subject, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;padding:24px">
      <div style="text-align:center;margin-bottom:20px">
        <svg width="40" height="40" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="180" height="180" rx="30" fill="#e30613"/><line x1="30" y1="30" x2="82" y2="95" stroke="#fff" stroke-width="10" stroke-linecap="round"/><polygon points="100,38 108,80 145,55 118,88 158,92 120,105 148,138 108,118 100,162 92,118 52,138 80,105 42,92 82,88 55,55 92,80" fill="#fff"/></svg>
      </div>
      <div style="background:#fff;border:1px solid #d0d8e8;border-radius:12px;padding:28px;margin-bottom:16px">
        ${body}
      </div>
      <div style="text-align:center;font-size:11px;color:#a0aec0;line-height:1.6">
        Boxer Soldas — hub.boxersoldas.com.br<br>
        Este email foi enviado automaticamente pelo Boxer Hub.
      </div>
    </div>
  </body></html>`;
}

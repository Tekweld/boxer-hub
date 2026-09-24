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

-- Edicao completa de orcamento (2026-11-27, pedido do Andre): o orcamento pode ser editado VARIAS vezes depois de salvo
-- (itens, precos, tabela/classe, forma de pagamento, parcelas, frete). Cada edicao guarda a versao ANTERIOR em
-- comercial.orcamento_revisoes e incrementa orcamentos.revisao; o link/PDF mostram sempre a revisao vigente.
-- Aceite do cliente nao e mais exigido: quem aprova e o representante dono ou a equipe Boxer.

alter table comercial.orcamentos add column if not exists forma_pagamento text;
alter table comercial.orcamentos add column if not exists revisao int not null default 1;
alter table comercial.orcamentos add column if not exists editado_em timestamptz;
alter table comercial.orcamentos add column if not exists editado_por uuid;
comment on column comercial.orcamentos.forma_pagamento is 'boleto | cartao_credito | pix | transferencia | credix. pagamento_tipo (avista/boleto) segue valendo para a formula de preco.';
comment on column comercial.orcamentos.revisao is 'Numero da revisao vigente (1 = original). A cada edicao salva a anterior vai para orcamento_revisoes.';

create table if not exists comercial.orcamento_revisoes (
  id uuid primary key default gen_random_uuid(),
  orcamento_id uuid not null references comercial.orcamentos(id) on delete cascade,
  revisao int not null,                 -- numero da revisao que ESTE snapshot representa (a que foi substituida)
  usuario_id uuid,                      -- quem fez a edicao que a substituiu
  usuario_nome text,
  snapshot jsonb not null,              -- linha do orcamento antes da edicao (itens, precos, pagamento, frete, totais)
  criado_em timestamptz not null default now(),
  unique (orcamento_id, revisao)
);
create index if not exists ix_orcamento_revisoes_orc on comercial.orcamento_revisoes (orcamento_id, revisao desc);
alter table comercial.orcamento_revisoes enable row level security;
revoke all on comercial.orcamento_revisoes from public, anon, authenticated;

-- RPC publica do link: passa a devolver forma_pagamento e revisao (o resto fica igual).
create or replace function comercial.buscar_orcamento_publico_v2(p_token uuid, p_sessao text, p_ua text default null::text, p_contar boolean default true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare o comercial.orcamentos%rowtype; v_exp boolean; v_email text;
begin
  if p_sessao is not null and p_sessao <> '' then
    v_email := public.link_sessao_email('orcamento', p_token::text, p_sessao);
    if v_email is null then return jsonb_build_object('encontrado', false, 'sessao', false); end if;
  else
    v_email := 'link_direto';
  end if;
  select * into o from comercial.orcamentos where token = p_token and ativo;
  if not found then return jsonb_build_object('encontrado', false); end if;
  v_exp := o.validade_em < now() and o.status in ('enviado','visualizado');
  if o.status <> 'cancelado' and p_contar then
    update comercial.orcamentos set
      visualizacoes = visualizacoes + 1,
      primeira_visualizacao_em = coalesce(primeira_visualizacao_em, now()),
      ultima_visualizacao_em = now(),
      status = case when status = 'enviado' and not v_exp then 'visualizado' else status end,
      atualizado_em = now()
    where id = o.id;
    perform public.link_registrar('orcamento', p_token::text, o.id, o.codigo, v_email, 'visualizou', p_ua);
  end if;
  return jsonb_build_object(
    'encontrado', true, 'visualizador', v_email,
    'codigo', o.codigo, 'criado_em', o.criado_em, 'validade_em', o.validade_em,
    'expirado', v_exp, 'status', o.status,
    'vendedor_nome', o.vendedor_nome, 'vendedor_email', o.vendedor_email, 'vendedor_telefone', o.vendedor_telefone,
    'vendedor_empresa', o.vendedor_empresa,
    'cliente_nome', o.cliente_nome, 'cliente_fantasia', o.cliente_fantasia, 'cliente_cnpj', o.cliente_cnpj,
    'cliente_contato', o.cliente_contato, 'cliente_cidade', o.cliente_cidade, 'cliente_uf', o.cliente_uf,
    'cliente_endereco', o.cliente_endereco,
    'uf', o.uf, 'pagamento_tipo', o.pagamento_tipo, 'forma_pagamento', o.forma_pagamento, 'revisao', o.revisao,
    'parcelas', o.parcelas, 'dias_pagamento', o.dias_pagamento, 'desconto_vista_pct', o.desconto_vista_pct,
    'frete_tipo', o.frete_tipo, 'frete_valor', o.frete_valor, 'observacoes', o.observacoes,
    'itens', o.itens, 'total_itens', o.total_itens, 'total_final', o.total_final,
    'aceito_em', o.aceito_em);
end $function$;

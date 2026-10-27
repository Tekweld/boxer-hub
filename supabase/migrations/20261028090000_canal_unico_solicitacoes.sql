-- Fase 2 do roadmap do Portal Completo: canal unico de contato.
--
-- Em vez de chat flutuante generico (baixa adesao em outros portais B2B),
-- o botao "Abrir solicitacao" fica ancorado a um item especifico (pedido,
-- titulo, nota fiscal) -- chega com o contexto certo, cai na fila do
-- representante responsavel (hub_carteira) e some de WhatsApp/telefone
-- para ficar registrado e consultavel dentro do Hub.
--
-- hub_solicitacoes = o ticket. hub_solicitacao_mensagens = o fio de
-- conversa (append-only, como hub_pedido_eventos).

create table comercial.hub_solicitacoes (
  id               uuid primary key default gen_random_uuid(),
  numero           varchar(20) unique,
  cliente_id       uuid not null references comercial.hub_clientes(id),
  representante_id uuid references comercial.hub_representantes(id),
  aberto_por       uuid not null default auth.uid(),
  aberto_por_tipo  varchar(20) not null check (aberto_por_tipo in ('cliente', 'representante')),
  referencia_tipo  varchar(20) not null check (referencia_tipo in ('pedido', 'titulo', 'nota_fiscal', 'geral')),
  referencia_id    uuid,
  assunto          varchar(200) not null,
  status           varchar(20) not null default 'aberta'
                     check (status in ('aberta', 'em_andamento', 'respondida', 'resolvida')),
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  ativo            boolean not null default true
);

create index hub_solicitacoes_cliente_idx on comercial.hub_solicitacoes(cliente_id);
create index hub_solicitacoes_representante_idx on comercial.hub_solicitacoes(representante_id);
create index hub_solicitacoes_referencia_idx on comercial.hub_solicitacoes(referencia_tipo, referencia_id);
create index hub_solicitacoes_status_idx on comercial.hub_solicitacoes(status) where ativo = true;

create table comercial.hub_solicitacao_mensagens (
  id             uuid primary key default gen_random_uuid(),
  solicitacao_id uuid not null references comercial.hub_solicitacoes(id) on delete cascade,
  autor_id       uuid not null default auth.uid(),
  autor_tipo     varchar(20) not null check (autor_tipo in ('cliente', 'representante', 'funcionario')),
  autor_nome     varchar(150),
  mensagem       text not null,
  criado_em      timestamptz not null default now()
);

create index hub_solicitacao_mensagens_solicitacao_idx on comercial.hub_solicitacao_mensagens(solicitacao_id, criado_em);

alter table comercial.hub_solicitacoes enable row level security;
alter table comercial.hub_solicitacao_mensagens enable row level security;

-- Visibilidade igual a de qualquer outro dado do cliente: reaproveita a
-- mesma funcao usada em hub_pedidos/hub_titulos/etc.
create policy hub_solicitacoes_select on comercial.hub_solicitacoes
  for select using (comercial.hub_pode_acessar_cliente(cliente_id));

create policy hub_solicitacoes_insert on comercial.hub_solicitacoes
  for insert with check (comercial.hub_pode_acessar_cliente(cliente_id));

create policy hub_solicitacoes_update on comercial.hub_solicitacoes
  for update using (comercial.hub_pode_acessar_cliente(cliente_id));

create policy hub_solicitacao_mensagens_select on comercial.hub_solicitacao_mensagens
  for select using (
    exists (
      select 1 from comercial.hub_solicitacoes s
       where s.id = solicitacao_id
         and comercial.hub_pode_acessar_cliente(s.cliente_id)
    )
  );

create policy hub_solicitacao_mensagens_insert on comercial.hub_solicitacao_mensagens
  for insert with check (
    exists (
      select 1 from comercial.hub_solicitacoes s
       where s.id = solicitacao_id
         and comercial.hub_pode_acessar_cliente(s.cliente_id)
    )
  );

-- Numero sequencial por ano, mesmo padrao de hub_fn_gerar_numero() (HUB-).
create or replace function comercial.hub_fn_gerar_numero_solicitacao()
returns text
language plpgsql
as $$
declare
  ano text := extract(year from now())::text;
  seq integer;
begin
  select coalesce(max(cast(substring(numero from 10) as integer)), 0) + 1
    into seq
    from comercial.hub_solicitacoes
   where numero like 'SOL-' || ano || '-%';

  return 'SOL-' || ano || '-' || lpad(seq::text, 5, '0');
end;
$$;

-- Preenche numero e representante_id (via hub_carteira) antes de gravar --
-- quem abre a solicitacao nem sempre sabe (ou deveria escolher) qual
-- representante atende aquele cliente.
create or replace function comercial.hub_trg_solicitacao_preencher()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if NEW.numero is null then
    NEW.numero := comercial.hub_fn_gerar_numero_solicitacao();
  end if;

  if NEW.representante_id is null then
    select representante_id into NEW.representante_id
      from comercial.hub_carteira
     where cliente_id = NEW.cliente_id and ativo = true
     limit 1;
  end if;

  return NEW;
end;
$$;

create trigger hub_trg_solicitacoes_preencher
  before insert on comercial.hub_solicitacoes
  for each row execute function comercial.hub_trg_solicitacao_preencher();

-- Notifica o representante quando o cliente abre uma solicitacao nova.
create or replace function comercial.hub_trg_notif_solicitacao_aberta()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_user_id uuid;
begin
  if NEW.representante_id is not null then
    select user_id into v_user_id
      from comercial.hub_representantes
     where id = NEW.representante_id;

    if v_user_id is not null then
      insert into comercial.hub_notificacoes (usuario_id, tipo, titulo, referencia_tipo, referencia_id)
      values (v_user_id, 'solicitacao_aberta',
              'Nova solicitacao ' || coalesce(NEW.numero, NEW.id::text) || ' — ' || NEW.assunto,
              'solicitacao', NEW.id);
    end if;
  end if;

  return NEW;
end;
$$;

create trigger hub_trg_notif_solicitacao_aberta
  after insert on comercial.hub_solicitacoes
  for each row execute function comercial.hub_trg_notif_solicitacao_aberta();

-- Cada mensagem nova: notifica o outro lado da conversa (cliente <-> quem
-- atende) e marca a solicitacao como respondida quando quem respondeu nao
-- foi o cliente, ou em_andamento quando o cliente volta a escrever.
create or replace function comercial.hub_trg_notif_solicitacao_mensagem()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_sol record;
  v_user_id uuid;
  v_novo_status text;
begin
  select * into v_sol from comercial.hub_solicitacoes where id = NEW.solicitacao_id;
  if v_sol is null then
    return NEW;
  end if;

  if NEW.autor_tipo = 'cliente' then
    v_novo_status := 'em_andamento';
    if v_sol.representante_id is not null then
      select user_id into v_user_id from comercial.hub_representantes where id = v_sol.representante_id;
    end if;
  else
    v_novo_status := 'respondida';
    select user_id into v_user_id from comercial.hub_clientes where id = v_sol.cliente_id;
  end if;

  update comercial.hub_solicitacoes
     set status = v_novo_status, atualizado_em = now()
   where id = NEW.solicitacao_id;

  if v_user_id is not null then
    insert into comercial.hub_notificacoes (usuario_id, tipo, titulo, referencia_tipo, referencia_id)
    values (v_user_id, 'solicitacao_mensagem',
            'Nova mensagem em ' || coalesce(v_sol.numero, v_sol.id::text) || ' — ' || v_sol.assunto,
            'solicitacao', v_sol.id);
  end if;

  return NEW;
end;
$$;

create trigger hub_trg_notif_solicitacao_mensagem
  after insert on comercial.hub_solicitacao_mensagens
  for each row execute function comercial.hub_trg_notif_solicitacao_mensagem();

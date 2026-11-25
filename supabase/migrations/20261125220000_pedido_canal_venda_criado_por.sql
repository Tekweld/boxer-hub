-- Dois dados que o Hub tinha e nao guardava no pedido (pedido do Andre, 2026-11-25):
--  * canal_venda: canal do CLIENTE (Varejo / Hibrido / Ecommerce) no momento do pedido.
--    Vai para o campo "Canal de vendas" da venda no ZEN e fica salvo aqui.
--  * criado_por: quem montou o pedido (representante/funcionario/cliente), para o ADM
--    ver no ZEN "pedido feito por ...".
alter table comercial.hub_pedidos
  add column if not exists canal_venda text,
  add column if not exists criado_por uuid default auth.uid();

-- Todo pedido novo (qualquer origem, inclusive importado do ZEN) nasce com o canal
-- do cliente; so preenche se ninguem informou.
create or replace function comercial.hub_trg_pedido_canal_venda()
returns trigger
language plpgsql
security definer
set search_path = comercial, public
as $$
begin
  if new.canal_venda is null and new.cliente_id is not null then
    select c.canal into new.canal_venda from comercial.hub_clientes c where c.id = new.cliente_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hub_pedido_canal_venda on comercial.hub_pedidos;
create trigger trg_hub_pedido_canal_venda
  before insert on comercial.hub_pedidos
  for each row execute function comercial.hub_trg_pedido_canal_venda();

-- Pedidos ja existentes: canal atual do cliente. O gatilho de "atualizado_em" fica
-- desligado so durante este UPDATE, para nao reordenar milhares de pedidos.
alter table comercial.hub_pedidos disable trigger trg_hub_pedidos_atualizado_em;
update comercial.hub_pedidos p
   set canal_venda = c.canal
  from comercial.hub_clientes c
 where c.id = p.cliente_id and p.canal_venda is null and c.canal is not null;
alter table comercial.hub_pedidos enable trigger trg_hub_pedidos_atualizado_em;

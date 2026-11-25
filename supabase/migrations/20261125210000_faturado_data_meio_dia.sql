-- hub_notas_fiscais.data_emissao e so DATA. Gravar o evento "Faturado" como
-- meia-noite UTC fazia a tela (fuso de Sao Paulo) mostrar o dia anterior.
-- Passa a gravar meio-dia de Sao Paulo, que cai no dia certo em qualquer fuso.
create or replace function comercial.hub_trg_evento_faturado()
returns trigger
language plpgsql
security definer
set search_path = comercial, public
as $$
begin
  if new.erp_pedido_id is null then
    return new;
  end if;

  insert into comercial.hub_pedido_eventos (pedido_id, etapa, origem, detalhe, criado_em)
  select p.id, 'Faturado', 'zen', 'NF ' || coalesce(new.numero_nf::text, ''),
         case when new.data_emissao is not null
              then (new.data_emissao::timestamp + interval '12 hours') at time zone 'America/Sao_Paulo'
              else now() end
  from comercial.hub_pedidos p
  where p.erp_pedido_id::text = new.erp_pedido_id::text
  on conflict (pedido_id, etapa) do nothing;

  update comercial.hub_pedidos
     set status = 'faturado', atualizado_em = now()
   where erp_pedido_id::text = new.erp_pedido_id::text
     and status in ('aprovado', 'em_separacao')
     and ativo;

  return new;
end;
$$;

-- Eventos ja criados na meia-noite UTC (hora exata 00:00:00+00) -> meio-dia SP do mesmo dia.
update comercial.hub_pedido_eventos
   set criado_em = ((criado_em at time zone 'UTC')::date::timestamp + interval '12 hours') at time zone 'America/Sao_Paulo'
 where etapa = 'Faturado' and origem = 'zen'
   and (criado_em at time zone 'UTC')::time = '00:00:00';

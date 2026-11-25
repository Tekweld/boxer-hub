-- Consolida vendas_adm/comercial/cadastro numa so area e adiciona "operacoes"
-- (NF, transporte, devolucao, agendamento) com roteamento automatico por categoria.

create or replace function comercial.hub_trg_solicitacao_preencher()
 returns trigger language plpgsql security definer set search_path to ''
as $function$
begin
  if NEW.numero is null then NEW.numero := comercial.hub_fn_gerar_numero_solicitacao(); end if;
  if NEW.representante_id is null then
    select representante_id into NEW.representante_id
      from comercial.hub_carteira
     where cliente_id = NEW.cliente_id and ativo = true limit 1;
  end if;
  if NEW.area_responsavel is null then
    NEW.area_responsavel := case
      when NEW.categoria = 'financeiro' then 'financeiro'
      when NEW.categoria in ('problema_entrega', 'documentacao') then 'operacoes'
      else 'vendas_adm'
    end;
  end if;
  return NEW;
end;
$function$;

update comercial.hub_solicitacoes
   set area_responsavel = 'operacoes'
 where categoria in ('problema_entrega', 'documentacao')
   and area_responsavel = 'vendas_adm';

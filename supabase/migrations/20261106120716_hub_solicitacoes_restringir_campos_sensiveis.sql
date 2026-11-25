-- Achado em auditoria (2026-11-04): a RLS de UPDATE de hub_solicitacoes so
-- restringe por CLIENTE (hub_pode_acessar_cliente), nao por COLUNA -- RLS
-- nao faz isso sozinha, precisa de trigger. Hoje nada impede, via chamada
-- direta a API (fora da tela), que um dealer ou representante setem
-- status='em_andamento'/'resolvida' fingindo ter sido assumido, ou mudem
-- area_responsavel -- corrompendo a fila e o indicador de horas por
-- area/pessoa que o canal de resolucao depende. A tela (hub.js) ja respeita
-- isso client-side (podeAssumirSolicitacao so libera pra tipo=funcionario),
-- mas client-side nao e seguranca. Cliente/representante continuam podendo
-- fechar a PROPRIA solicitacao (status='resolvida', fluxo legitimo e
-- existente do botao "Marcar como concluida" em qualquer tipo de usuario).
create or replace function comercial.hub_trg_solicitacao_restringir_campos()
 returns trigger language plpgsql security definer set search_path to 'comercial', 'public'
as $function$
begin
  if comercial.hub_user_tipo() <> 'funcionario' and comercial.hub_user_role() not in ('admin', 'manager') then
    if NEW.status is distinct from OLD.status and NEW.status <> 'resolvida' then
      NEW.status := OLD.status;
    end if;
    NEW.area_responsavel := OLD.area_responsavel;
    NEW.assumido_por := OLD.assumido_por;
    NEW.assumido_por_nome := OLD.assumido_por_nome;
    NEW.assumido_em := OLD.assumido_em;
  end if;
  return NEW;
end;
$function$;

drop trigger if exists trg_hub_solicitacao_restringir_campos on comercial.hub_solicitacoes;
create trigger trg_hub_solicitacao_restringir_campos
  before update on comercial.hub_solicitacoes
  for each row execute function comercial.hub_trg_solicitacao_restringir_campos();

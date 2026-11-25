-- Item 9, otimizado (Andre, 2026-11-16): backfill de historico ZEN nao roda
-- contra a base inteira (7.770 clientes) de uma vez -- vira fila alimentada
-- por evento (novo representante com login, novo cliente convidado, nova
-- carteira), drenada aos poucos pelo cron ja existente. Hoje so 6 reps e 4
-- clientes tem login de verdade no Hub -- a carteira deles (2127 clientes)
-- e o universo real, nao os 7770 sincronizados do ZEN em bloco.
CREATE TABLE comercial.hub_backfill_fila (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES comercial.hub_clientes(id),
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'concluido', 'erro')),
  tentativas integer NOT NULL DEFAULT 0,
  erro_detalhe text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cliente_id)
);

ALTER TABLE comercial.hub_backfill_fila ENABLE ROW LEVEL SECURITY;
CREATE POLICY hub_backfill_fila_admin_select ON comercial.hub_backfill_fila
  FOR SELECT TO authenticated USING (comercial.hub_user_role() = 'admin');

CREATE INDEX hub_backfill_fila_status_idx ON comercial.hub_backfill_fila (status) WHERE status = 'pendente';

-- Enfileira sem duplicar (UNIQUE cliente_id) e sem reprocessar quem ja
-- concluiu -- se ja existir a linha, so reabre pra 'pendente' se tinha dado
-- erro antes (nunca reabre um 'concluido').
CREATE OR REPLACE FUNCTION comercial.hub_fn_enfileirar_backfill(p_cliente_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO comercial.hub_backfill_fila (cliente_id) VALUES (p_cliente_id)
  ON CONFLICT (cliente_id) DO UPDATE
    SET status = 'pendente', atualizado_em = now()
    WHERE comercial.hub_backfill_fila.status = 'erro';
END;
$function$;

-- Gatilho 1: novo login no Hub (hub_perfis) -- representante enfileira toda
-- a carteira dele de uma vez; cliente enfileira so o proprio cadastro.
CREATE OR REPLACE FUNCTION comercial.hub_trg_perfil_novo_enfileira_backfill()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_cid uuid;
BEGIN
  IF NEW.ativo IS NOT TRUE THEN RETURN NEW; END IF;

  IF NEW.tipo = 'cliente' AND NEW.cliente_id IS NOT NULL THEN
    PERFORM comercial.hub_fn_enfileirar_backfill(NEW.cliente_id);
  ELSIF NEW.tipo = 'representante' AND NEW.representante_id IS NOT NULL THEN
    FOR v_cid IN
      SELECT cliente_id FROM comercial.hub_carteira
       WHERE representante_id = NEW.representante_id AND ativo = true
    LOOP
      PERFORM comercial.hub_fn_enfileirar_backfill(v_cid);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER hub_trg_perfil_novo_enfileira_backfill
  AFTER INSERT ON comercial.hub_perfis
  FOR EACH ROW EXECUTE FUNCTION comercial.hub_trg_perfil_novo_enfileira_backfill();

-- Gatilho 2: cliente novo entra na carteira de um representante que JA tem
-- login ativo -- enfileira so esse cliente (o rep ja foi coberto quando
-- logou a primeira vez; sem isso, um cliente adicionado depois nunca entraria).
CREATE OR REPLACE FUNCTION comercial.hub_trg_carteira_nova_enfileira_backfill()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.ativo IS NOT TRUE THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM comercial.hub_perfis
     WHERE representante_id = NEW.representante_id AND tipo = 'representante' AND ativo = true
  ) THEN
    PERFORM comercial.hub_fn_enfileirar_backfill(NEW.cliente_id);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER hub_trg_carteira_nova_enfileira_backfill
  AFTER INSERT ON comercial.hub_carteira
  FOR EACH ROW EXECUTE FUNCTION comercial.hub_trg_carteira_nova_enfileira_backfill();

-- Semente: cobre agora os representantes/clientes que ja tem login ativo
-- hoje, sem esperar um cadastro novo pra comecar a valer.
INSERT INTO comercial.hub_backfill_fila (cliente_id)
SELECT DISTINCT hc.cliente_id
FROM comercial.hub_carteira hc
JOIN comercial.hub_perfis p ON p.representante_id = hc.representante_id AND p.ativo = true AND p.tipo = 'representante'
WHERE hc.ativo = true
ON CONFLICT (cliente_id) DO NOTHING;

INSERT INTO comercial.hub_backfill_fila (cliente_id)
SELECT DISTINCT p.cliente_id
FROM comercial.hub_perfis p
WHERE p.ativo = true AND p.tipo = 'cliente' AND p.cliente_id IS NOT NULL
ON CONFLICT (cliente_id) DO NOTHING;

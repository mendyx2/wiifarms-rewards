-- Constraint tests for db/schema.sql. Run after the schema on an empty database.
-- Each "must_fail" call proves the database itself rejects an unsafe action.
-- Everything runs in one transaction that is rolled back at the end.

BEGIN;

CREATE FUNCTION pg_temp.must_fail(label text, stmt text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    -- Deferred constraints only fire at commit; force them now.
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok   - % (%)', label, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL - % was allowed', label;
END $$;

-- Fixtures -------------------------------------------------------------------
INSERT INTO admin_users (id, email, full_name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'manager@example.test',  'Cycle Manager'),
  ('00000000-0000-0000-0000-0000000000a2', 'ops@example.test',      'Ops Approver'),
  ('00000000-0000-0000-0000-0000000000a3', 'finance@example.test',  'Finance Approver'),
  ('00000000-0000-0000-0000-0000000000a4', 'auditor@example.test',  'Appointed Auditor'),
  ('00000000-0000-0000-0000-0000000000a5', 'other@example.test',    'Other Auditor');

INSERT INTO users (id, phone_e164) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '+2348000000001'),
  ('00000000-0000-0000-0000-0000000000b2', '+2348000000002');

INSERT INTO cycles (id, name, mode, ticket_price_kobo, total_tickets, max_tickets_per_account,
                    sales_open_at, sales_close_at, draw_at, created_by)
VALUES ('00000000-0000-0000-0000-0000000000c1', 'Test cycle', 'REAL_MONEY', 20000, 3, 2,
        now(), now() + interval '30 days', now() + interval '31 days',
        '00000000-0000-0000-0000-0000000000a1');

INSERT INTO prize_tiers (id, cycle_id, stage, kind, outcome_code, title, cash_kobo, quantity, draw_order) VALUES
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1',
   'INSTANT', 'CASH', 'CASH:50000', '₦500', 50000, 1, NULL),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1',
   'FINAL_DRAW', 'CASH', 'CASH:10000000', '₦100,000', 10000000, 1, 1);

-- Roles ----------------------------------------------------------------------
SELECT pg_temp.must_fail('self-granted role',
  $$INSERT INTO admin_roles VALUES ('00000000-0000-0000-0000-0000000000a3','FINANCE','00000000-0000-0000-0000-0000000000a3')$$);
INSERT INTO admin_roles VALUES ('00000000-0000-0000-0000-0000000000a3','FINANCE','00000000-0000-0000-0000-0000000000a2');
SELECT pg_temp.must_fail('finance + payout approver on one person',
  $$INSERT INTO admin_roles VALUES ('00000000-0000-0000-0000-0000000000a3','PAYOUT_APPROVER','00000000-0000-0000-0000-0000000000a2')$$);
SELECT pg_temp.must_fail('auditor holding an operational role',
  $$INSERT INTO admin_roles VALUES ('00000000-0000-0000-0000-0000000000a3','AUDITOR','00000000-0000-0000-0000-0000000000a2')$$);

-- Cycle approval -------------------------------------------------------------
SELECT pg_temp.must_fail('instant prize outside ₦500–₦10,000',
  $$INSERT INTO prize_tiers (cycle_id, stage, kind, outcome_code, title, cash_kobo, quantity)
    VALUES ('00000000-0000-0000-0000-0000000000c1','INSTANT','CASH','CASH:5000000','₦50,000',5000000,1)$$);
SELECT pg_temp.must_fail('skipping straight to OPEN',
  $$UPDATE cycles SET status = 'OPEN' WHERE id = '00000000-0000-0000-0000-0000000000c1'$$);
SELECT pg_temp.must_fail('creating a cycle already OPEN',
  $$INSERT INTO cycles (name, status, ticket_price_kobo, total_tickets, max_tickets_per_account,
                        sales_open_at, sales_close_at, draw_at, created_by)
    VALUES ('x','OPEN',20000,3,2, now(), now() + interval '1 day', now() + interval '2 days',
            '00000000-0000-0000-0000-0000000000a1')$$);

UPDATE cycles SET status = 'SUBMITTED' WHERE id = '00000000-0000-0000-0000-0000000000c1';

SELECT pg_temp.must_fail('creator approving own cycle',
  $$INSERT INTO cycle_approvals (cycle_id, approver_id, capacity)
    VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1','OPERATIONS')$$);
INSERT INTO cycle_approvals (cycle_id, approver_id, capacity)
  VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a2','OPERATIONS');
SELECT pg_temp.must_fail('approving with only one approver',
  $$UPDATE cycles SET status = 'APPROVED' WHERE id = '00000000-0000-0000-0000-0000000000c1'$$);
SELECT pg_temp.must_fail('same person giving both approvals',
  $$INSERT INTO cycle_approvals (cycle_id, approver_id, capacity)
    VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a2','FINANCE')$$);
INSERT INTO cycle_approvals (cycle_id, approver_id, capacity)
  VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a3','FINANCE');

SELECT pg_temp.must_fail('approving without evidence or auditor',
  $$UPDATE cycles SET status = 'APPROVED' WHERE id = '00000000-0000-0000-0000-0000000000c1'$$);
SELECT pg_temp.must_fail('approving with under-funded escrow',
  $$UPDATE cycles SET status = 'APPROVED', financial_model_ref = 'fm', rules_document_ref = 'rules',
      rules_sha256 = sha256('rules'), auditor_admin_id = '00000000-0000-0000-0000-0000000000a4',
      escrow_reference = 'ESC-1', escrow_funded_kobo = 10049999
    WHERE id = '00000000-0000-0000-0000-0000000000c1'$$);
UPDATE cycles SET status = 'APPROVED', financial_model_ref = 'fm', rules_document_ref = 'rules',
    rules_sha256 = sha256('rules'), auditor_admin_id = '00000000-0000-0000-0000-0000000000a4',
    escrow_reference = 'ESC-1', escrow_funded_kobo = 10050000
  WHERE id = '00000000-0000-0000-0000-0000000000c1';

-- Locked after approval --------------------------------------------------------
SELECT pg_temp.must_fail('changing ticket price after approval',
  $$UPDATE cycles SET ticket_price_kobo = 50000 WHERE id = '00000000-0000-0000-0000-0000000000c1'$$);
SELECT pg_temp.must_fail('changing draw date after approval',
  $$UPDATE cycles SET draw_at = draw_at + interval '1 day' WHERE id = '00000000-0000-0000-0000-0000000000c1'$$);
SELECT pg_temp.must_fail('editing a prize tier after approval',
  $$UPDATE prize_tiers SET quantity = 0 + 2 WHERE id = '00000000-0000-0000-0000-0000000000d1'$$);
SELECT pg_temp.must_fail('removing a prize tier after approval',
  $$DELETE FROM prize_tiers WHERE id = '00000000-0000-0000-0000-0000000000d2'$$);
SELECT pg_temp.must_fail('adding a prize tier after approval',
  $$INSERT INTO prize_tiers (cycle_id, stage, kind, outcome_code, title, cash_kobo, quantity)
    VALUES ('00000000-0000-0000-0000-0000000000c1','INSTANT','CASH','CASH:100000','₦1,000',100000,1)$$);
SELECT pg_temp.must_fail('deleting an approval',
  $$DELETE FROM cycle_approvals WHERE cycle_id = '00000000-0000-0000-0000-0000000000c1'$$);

-- Tickets and commitments ------------------------------------------------------
INSERT INTO tickets (id, cycle_id, serial, leaf_index, leaf_hash, outcome_ciphertext) VALUES
  ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000c1','WR-AAA',0,sha256('1'),'\x01'),
  ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000c1','WR-BBB',1,sha256('2'),'\x02'),
  ('00000000-0000-0000-0000-0000000000e3','00000000-0000-0000-0000-0000000000c1','WR-CCC',2,sha256('3'),'\x03');

SELECT pg_temp.must_fail('COMMITTED without published commitments',
  $$UPDATE cycles SET status = 'COMMITTED' WHERE id = '00000000-0000-0000-0000-0000000000c1'$$);
INSERT INTO cycle_commitments (cycle_id, game_core_version, ticket_merkle_root, prize_table_sha256,
                               draw_secret_commitment, kms_key_ref)
  VALUES ('00000000-0000-0000-0000-0000000000c1','v-test',sha256('root'),sha256('table'),sha256('secret'),'kms/key/1');
SELECT pg_temp.must_fail('changing the published Merkle root',
  $$UPDATE cycle_commitments SET ticket_merkle_root = sha256('other')$$);
UPDATE cycles SET status = 'COMMITTED' WHERE id = '00000000-0000-0000-0000-0000000000c1';

SELECT pg_temp.must_fail('generating extra tickets after commit',
  $$INSERT INTO tickets (cycle_id, serial, leaf_index, leaf_hash, outcome_ciphertext)
    VALUES ('00000000-0000-0000-0000-0000000000c1','WR-DDD',3,sha256('4'),'\x04')$$);

INSERT INTO orders (id, user_id, cycle_id, quantity, amount_kobo, idempotency_key, reserved_until) VALUES
  ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000b1',
   '00000000-0000-0000-0000-0000000000c1',1,20000,'k1', now() + interval '10 minutes');

SELECT pg_temp.must_fail('selling a ticket before the cycle is OPEN',
  $$UPDATE tickets SET status='SOLD', owner_id='00000000-0000-0000-0000-0000000000b1',
      order_id='00000000-0000-0000-0000-0000000000f1', sold_at=now()
    WHERE id='00000000-0000-0000-0000-0000000000e1'$$);

-- The paid-entry gate ----------------------------------------------------------
SELECT pg_temp.must_fail('opening real-money sales with no licence',
  $$UPDATE cycles SET status = 'OPEN' WHERE id = '00000000-0000-0000-0000-0000000000c1'$$);
INSERT INTO licences (state_code, authority, licence_number, valid_from, valid_to, document_ref, recorded_by)
  VALUES ('NG-NI','Test authority','L-1', current_date - 1, current_date + 365, 'doc',
          '00000000-0000-0000-0000-0000000000a2');
SELECT pg_temp.must_fail('opening real-money sales with uncertified game core',
  $$UPDATE cycles SET status = 'OPEN' WHERE id = '00000000-0000-0000-0000-0000000000c1'$$);
INSERT INTO certifications (component, component_version, lab, certificate_ref, valid_from, recorded_by)
  VALUES ('GAME_CORE','v-test','Test lab','C-1', current_date - 1, '00000000-0000-0000-0000-0000000000a2');
UPDATE cycles SET status = 'OPEN' WHERE id = '00000000-0000-0000-0000-0000000000c1';

-- Ticket lifecycle -------------------------------------------------------------
SELECT pg_temp.must_fail('duplicate order with same idempotency key',
  $$INSERT INTO orders (user_id, cycle_id, quantity, amount_kobo, idempotency_key, reserved_until)
    VALUES ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',1,20000,'k1', now())$$);

UPDATE tickets SET status='SOLD', owner_id='00000000-0000-0000-0000-0000000000b1',
    order_id='00000000-0000-0000-0000-0000000000f1', sold_at=now()
  WHERE id='00000000-0000-0000-0000-0000000000e1';

SELECT pg_temp.must_fail('re-assigning a sold ticket to another player',
  $$UPDATE tickets SET owner_id='00000000-0000-0000-0000-0000000000b2' WHERE id='00000000-0000-0000-0000-0000000000e1'$$);
SELECT pg_temp.must_fail('swapping a ticket''s encrypted outcome',
  $$UPDATE tickets SET outcome_ciphertext='\xff' WHERE id='00000000-0000-0000-0000-0000000000e1'$$);
SELECT pg_temp.must_fail('swapping a ticket''s leaf hash',
  $$UPDATE tickets SET leaf_hash=sha256('x') WHERE id='00000000-0000-0000-0000-0000000000e2'$$);
SELECT pg_temp.must_fail('revealing an unsold ticket',
  $$UPDATE tickets SET status='REVEALED', revealed_at=now(), revealed_outcome='NONE', revealed_salt='\x00'
    WHERE id='00000000-0000-0000-0000-0000000000e2'$$);
SELECT pg_temp.must_fail('deleting a ticket',
  $$DELETE FROM tickets WHERE id='00000000-0000-0000-0000-0000000000e3'$$);

UPDATE tickets SET status='REVEALED', revealed_at=now(), revealed_outcome='CASH:50000', revealed_salt='\x00'
  WHERE id='00000000-0000-0000-0000-0000000000e1';
SELECT pg_temp.must_fail('altering a revealed outcome',
  $$UPDATE tickets SET revealed_outcome='CASH:1000000' WHERE id='00000000-0000-0000-0000-0000000000e1'$$);
SELECT pg_temp.must_fail('un-revealing a ticket',
  $$UPDATE tickets SET status='SOLD', revealed_at=NULL, revealed_outcome=NULL, revealed_salt=NULL
    WHERE id='00000000-0000-0000-0000-0000000000e1'$$);

INSERT INTO prize_claims (ticket_id, stage, prize_tier_id, user_id, expires_at)
  VALUES ('00000000-0000-0000-0000-0000000000e1','INSTANT','00000000-0000-0000-0000-0000000000d1',
          '00000000-0000-0000-0000-0000000000b1', now() + interval '90 days');
SELECT pg_temp.must_fail('claiming the same ticket twice',
  $$INSERT INTO prize_claims (ticket_id, stage, prize_tier_id, user_id, expires_at)
    VALUES ('00000000-0000-0000-0000-0000000000e1','INSTANT','00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-0000000000b1', now() + interval '90 days')$$);

-- Payments ---------------------------------------------------------------------
SELECT pg_temp.must_fail('marking a payment succeeded without server-side verification',
  $$INSERT INTO payments (order_id, provider, provider_ref, amount_kobo, status)
    VALUES ('00000000-0000-0000-0000-0000000000f1','SIMULATED','p0',20000,'SUCCEEDED')$$);
INSERT INTO payments (id, order_id, provider, provider_ref, amount_kobo, status, verified_at)
  VALUES ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-0000000000f1','SIMULATED','p1',20000,'SUCCEEDED',now());
SELECT pg_temp.must_fail('second successful payment for one order',
  $$INSERT INTO payments (order_id, provider, provider_ref, amount_kobo, status, verified_at)
    VALUES ('00000000-0000-0000-0000-0000000000f1','SIMULATED','p2',20000,'SUCCEEDED',now())$$);
INSERT INTO payment_events (provider, provider_event_id, signature_valid, payload) VALUES ('SIMULATED','evt-1',true,'{}');
SELECT pg_temp.must_fail('processing the same webhook twice',
  $$INSERT INTO payment_events (provider, provider_event_id, signature_valid, payload) VALUES ('SIMULATED','evt-1',true,'{}')$$);
SELECT pg_temp.must_fail('manual refund approved by its requester',
  $$INSERT INTO refunds (payment_id, amount_kobo, reason, requested_by, approved_by)
    VALUES ('00000000-0000-0000-0000-000000000101',20000,'INELIGIBLE_PURCHASE',
            '00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000a3')$$);
SELECT pg_temp.must_fail('automatic refund for a discretionary reason',
  $$INSERT INTO refunds (payment_id, amount_kobo, reason) VALUES ('00000000-0000-0000-0000-000000000101',20000,'DISPUTED_PAYMENT')$$);

-- Ledger -----------------------------------------------------------------------
INSERT INTO ledger_accounts (id, code, kind) VALUES
  ('00000000-0000-0000-0000-000000000201','GATEWAY_CLEARING','ASSET'),
  ('00000000-0000-0000-0000-000000000202','TICKET_REVENUE','REVENUE');

INSERT INTO ledger_transactions (id, kind, reference) VALUES ('00000000-0000-0000-0000-000000000301','TICKET_SALE','order:f1');
INSERT INTO ledger_entries (transaction_id, account_id, amount_kobo) VALUES
  ('00000000-0000-0000-0000-000000000301','00000000-0000-0000-0000-000000000201', 20000),
  ('00000000-0000-0000-0000-000000000301','00000000-0000-0000-0000-000000000202',-20000);
SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;

SELECT pg_temp.must_fail('unbalanced ledger transaction',
  $$WITH t AS (INSERT INTO ledger_transactions (kind, reference) VALUES ('ADJUSTMENT','bad-1') RETURNING id)
    INSERT INTO ledger_entries (transaction_id, account_id, amount_kobo)
    SELECT t.id, a.id, v.amt FROM t, (VALUES ('GATEWAY_CLEARING', 500), ('TICKET_REVENUE', -400)) v(code, amt)
    JOIN ledger_accounts a ON a.code = v.code$$);
SELECT pg_temp.must_fail('ledger transaction with no entries',
  $$INSERT INTO ledger_transactions (kind, reference) VALUES ('ADJUSTMENT','bad-2')$$);
SELECT pg_temp.must_fail('adding a one-sided entry to an old transaction',
  $$INSERT INTO ledger_entries (transaction_id, account_id, amount_kobo)
    VALUES ('00000000-0000-0000-0000-000000000301','00000000-0000-0000-0000-000000000201', 1)$$);
SELECT pg_temp.must_fail('posting the same business event twice',
  $$INSERT INTO ledger_transactions (kind, reference) VALUES ('TICKET_SALE','order:f1')$$);
SELECT pg_temp.must_fail('editing a ledger entry',
  $$UPDATE ledger_entries SET amount_kobo = 1$$);
SELECT pg_temp.must_fail('deleting a ledger entry',
  $$DELETE FROM ledger_entries$$);

DO $$ BEGIN
  ASSERT (SELECT balance_kobo FROM ledger_balances WHERE code = 'GATEWAY_CLEARING') = 20000, 'balance view';
END $$;

-- Payouts ----------------------------------------------------------------------
INSERT INTO bank_accounts (id, user_id, bank_code, account_number_enc, account_hash, resolved_name, name_match, usable_from)
  VALUES ('00000000-0000-0000-0000-000000000401','00000000-0000-0000-0000-0000000000b1','000','\x00','\x01','Test Player',true,now());
SELECT pg_temp.must_fail('sending an approval-required payout with no approver',
  $$INSERT INTO payouts (user_id, bank_account_id, amount_kobo, idempotency_key, status, requires_approval)
    VALUES ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000401',10000000,'po-1','SENT',true)$$);
SELECT pg_temp.must_fail('payout approved by the person who initiated it',
  $$INSERT INTO payouts (user_id, bank_account_id, amount_kobo, idempotency_key, status, requires_approval, initiated_by, approved_by)
    VALUES ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000401',10000000,'po-2','APPROVED',true,
            '00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000a3')$$);

-- Draw -------------------------------------------------------------------------
SELECT pg_temp.must_fail('running the draw before the cycle is closed',
  $$INSERT INTO draws (cycle_id, entries_count, entries_sha256, entries_snapshot_ref, beacon_source, beacon_round,
                       beacon_value, revealed_secret, seed, game_core_version, operator_1, operator_2, auditor_id, auditor_signed_at)
    VALUES ('00000000-0000-0000-0000-0000000000c1',1,sha256('e'),'ref','drand',1,sha256('b'),sha256('s'),sha256('seed'),'v-test',
            '00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000a4',now())$$);
UPDATE cycles SET status = 'CLOSED' WHERE id = '00000000-0000-0000-0000-0000000000c1';
SELECT pg_temp.must_fail('selling a ticket after close',
  $$UPDATE tickets SET status='SOLD', owner_id='00000000-0000-0000-0000-0000000000b1',
      order_id='00000000-0000-0000-0000-0000000000f1', sold_at=now()
    WHERE id='00000000-0000-0000-0000-0000000000e2'$$);
SELECT pg_temp.must_fail('draw run by a single operator',
  $$INSERT INTO draws (cycle_id, entries_count, entries_sha256, entries_snapshot_ref, beacon_source, beacon_round,
                       beacon_value, revealed_secret, seed, game_core_version, operator_1, operator_2, auditor_id, auditor_signed_at)
    VALUES ('00000000-0000-0000-0000-0000000000c1',1,sha256('e'),'ref','drand',1,sha256('b'),sha256('s'),sha256('seed'),'v-test',
            '00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a4',now())$$);
SELECT pg_temp.must_fail('draw countersigned by someone other than the appointed auditor',
  $$INSERT INTO draws (cycle_id, entries_count, entries_sha256, entries_snapshot_ref, beacon_source, beacon_round,
                       beacon_value, revealed_secret, seed, game_core_version, operator_1, operator_2, auditor_id, auditor_signed_at)
    VALUES ('00000000-0000-0000-0000-0000000000c1',1,sha256('e'),'ref','drand',1,sha256('b'),sha256('s'),sha256('seed'),'v-test',
            '00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000a5',now())$$);
INSERT INTO draws (cycle_id, entries_count, entries_sha256, entries_snapshot_ref, beacon_source, beacon_round,
                   beacon_value, revealed_secret, seed, game_core_version, operator_1, operator_2, auditor_id, auditor_signed_at)
  VALUES ('00000000-0000-0000-0000-0000000000c1',1,sha256('e'),'ref','drand',1,sha256('b'),sha256('s'),sha256('seed'),'v-test',
          '00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000a4',now());
SELECT pg_temp.must_fail('running the draw a second time',
  $$INSERT INTO draws (cycle_id, entries_count, entries_sha256, entries_snapshot_ref, beacon_source, beacon_round,
                       beacon_value, revealed_secret, seed, game_core_version, operator_1, operator_2, auditor_id, auditor_signed_at)
    VALUES ('00000000-0000-0000-0000-0000000000c1',1,sha256('e'),'ref','drand',2,sha256('b2'),sha256('s'),sha256('seed2'),'v-test',
            '00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000a4',now())$$);
SELECT pg_temp.must_fail('editing a completed draw',
  $$UPDATE draws SET seed = sha256('other')$$);
INSERT INTO draw_winners VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000d2',1,'00000000-0000-0000-0000-0000000000e1');
SELECT pg_temp.must_fail('changing a published winner',
  $$UPDATE draw_winners SET ticket_id = '00000000-0000-0000-0000-0000000000e2'$$);

-- Responsible gaming -------------------------------------------------------------
INSERT INTO self_exclusions (user_id, kind) VALUES ('00000000-0000-0000-0000-0000000000b1','SELF_EXCLUSION');
SELECT pg_temp.must_fail('removing a self-exclusion',
  $$DELETE FROM self_exclusions$$);
SELECT pg_temp.must_fail('shortening a self-exclusion',
  $$UPDATE self_exclusions SET ends_at = now() + interval '1 minute'$$);

-- Audit log ----------------------------------------------------------------------
INSERT INTO audit_log (actor_type, action, entity_type, entity_id, details)
  VALUES ('SYSTEM','cycle.opened','cycle','c1','{"a":1}'), ('ADMIN','draw.executed','cycle','c1','{}');
SELECT pg_temp.must_fail('editing an audit row',
  $$UPDATE audit_log SET details = '{}'$$);
SELECT pg_temp.must_fail('deleting an audit row',
  $$DELETE FROM audit_log$$);
DO $$ BEGIN
  ASSERT audit_log_verify() IS NULL, 'intact chain should verify';
  -- Simulate tampering by someone who can bypass triggers (e.g. a superuser).
  ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only;
  UPDATE audit_log SET details = '{"a":2}' WHERE seq = (SELECT min(seq) FROM audit_log);
  ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only;
  ASSERT audit_log_verify() = (SELECT min(seq) FROM audit_log), 'tampering should be detected';
  RAISE NOTICE 'ok   - audit chain detects tampering';
END $$;

ROLLBACK;
\echo ALL SCHEMA TESTS PASSED

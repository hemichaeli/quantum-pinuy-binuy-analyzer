-- Migration: rename quantum_events → minhelet_events
-- This table belongs to MINHELET (scheduling/events), not QUANTUM (analyzer)

ALTER TABLE IF EXISTS quantum_events RENAME TO minhelet_events;

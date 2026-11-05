-- A random token fences expired workers even when an operator resets the retry counter.
ALTER TABLE webhook_events ADD COLUMN "claimToken" UUID;

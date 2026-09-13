ALTER TABLE "onb_frontline_fulfillments"
  ADD CONSTRAINT "onb_frontline_fulfillment_ack_check"
  CHECK (("acknowledged_at" is null and "acknowledgement_recipient_reference" is null and "acknowledgement_method" is null) or ("acknowledged_at" is not null and "acknowledgement_recipient_reference" is not null and "acknowledgement_method" is not null));
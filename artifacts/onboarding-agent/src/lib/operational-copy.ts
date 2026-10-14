/** Presentation of typed delivery states only; never rewrite message content. */
export function deliveryStatusText(status: string): string {
  return ({ simulated: 'Not sent', 'logged-only': 'Recorded only — not sent',
    blocked: 'Delivery blocked', uncertain: 'Delivery not confirmed' } as Record<string, string>)[status]
    ?? status.replace(/-/g, ' ');
}

/** Preserve the persisted reference; hide only its reserved implementation prefix. */
export function operationalReferenceText(reference: string): string {
  return reference.replace(/^SIMULATED-OPS-/, 'OPS-');
}

/** Reserved adapter configuration labels only, never communication history. */
export function adapterVendorText(value: string): string {
  return value.replace(/\s+\(simulated\)$/, '');
}

export function adapterDescriptionText(value: string): string {
  return value.replace(', or simulated completion', '');
}

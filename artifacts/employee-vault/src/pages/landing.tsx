import { Link } from 'wouter';
import { motion } from 'framer-motion';
import { Show } from '@clerk/react';
import { ArrowRight, FileLock2, HandCoins, ShieldCheck, Undo2, Eye, Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Wordmark, Mark } from '@/components/vault-ui';

const reveal = { initial: { opacity: 0, y: 22 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true, margin: '-60px' }, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] as const } };

function Rings({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" fill="none" stroke="currentColor" aria-hidden>
      {[48, 40, 32, 24, 16, 8].map((r, i) => <circle key={r} cx="50" cy="50" r={r} strokeWidth={i % 2 ? 0.3 : 0.6} strokeDasharray={i % 3 === 2 ? '1 2' : undefined} />)}
      <circle cx="50" cy="50" r="2.4" fill="hsl(36 95% 62%)" stroke="none" />
    </svg>
  );
}

const faqs = [
  ['Does uploading a document mean I am background-checked?', 'No. Documents are stored and malware-scanned. A check only reports a result when a verification provider has actually confirmed it, and every check shows its issuer, source and dates. If no provider is available, the vault says so plainly.'],
  ['Does my login email count as verification?', 'No. Signing in proves you can reach an account. It is never treated as identity, employment or background verification.'],
  ['Who can see what is in my vault?', 'Only you. An employer request arrives as a request, not as access. By default an approval shares a summary only; raw documents are shared only when you tick them one by one.'],
  ['What does "this is my case" mean?', 'A request carries an employer case number. Before approving you confirm the case is yours. The employer then has to independently match you to that case after consent. Your confirmation alone does not do it.'],
  ['Can I change my mind?', 'Yes. Approved requests can be revoked from your dashboard or the request page at any time.'],
];

export default function Landing() {
  return (
    <div className="min-h-[100dvh]">
      <header className="mx-auto flex h-20 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Wordmark />
        <nav className="flex items-center gap-2">
          <Show when="signed-out">
            <Button asChild variant="ghost" data-testid="link-sign-in"><Link href="/sign-in">Sign in</Link></Button>
            <Button asChild data-testid="link-sign-up-nav"><Link href="/sign-up">Create vault</Link></Button>
          </Show>
          <Show when="signed-in">
            <Button asChild data-testid="link-dashboard"><Link href="/dashboard">Open vault</Link></Button>
          </Show>
        </nav>
      </header>

      <section className="relative mx-auto max-w-6xl overflow-hidden px-4 pb-24 pt-10 sm:px-6 md:pt-20">
        <Rings className="ring-breathe pointer-events-none absolute -right-48 -top-24 h-[640px] w-[640px] text-primary/25 md:-right-24 md:h-[780px] md:w-[780px]" />
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }} className="relative max-w-3xl">
          <p className="mb-6 inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-accent" /> Owned by you. Not by your employer.
          </p>
          <h1 className="font-display text-5xl font-medium leading-[1.02] text-foreground sm:text-7xl md:text-8xl">
            Prove who you are, <em className="text-primary">on your terms.</em>
          </h1>
          <p className="mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Employee Vault is a private portfolio for your verification documents and checks. It belongs to you, stays with you between jobs, and opens only when you approve a specific employer request.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Button asChild size="lg" className="h-12 px-6 text-base" data-testid="link-sign-up-hero"><Link href="/sign-up">Start your vault <ArrowRight className="ml-2 h-4 w-4" /></Link></Button>
            <Button asChild size="lg" variant="outline" className="h-12 px-6 text-base" data-testid="link-sign-in-hero"><Link href="/sign-in">I already have one</Link></Button>
          </div>
        </motion.div>
      </section>

      <section className="border-y bg-secondary/60">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 md:grid-cols-12">
          <motion.h2 {...reveal} className="font-display text-4xl font-medium md:col-span-5 md:text-5xl">Three steps. You hold the key to each.</motion.h2>
          <div className="space-y-10 md:col-span-7">
            {[
              [FileLock2, '01', 'Keep your documents', 'Upload PDF, JPEG or PNG files up to 10 MB. Each is scanned before it can be downloaded or used.'],
              [ShieldCheck, '02', 'Request checks', 'Choose a kind of check and a jurisdiction, and attach the documents that support it. Results appear with their issuer, source and expiry.'],
              [HandCoins, '03', 'Decide on requests', 'When an employer asks, you see their name, case number, purpose and scope. Approve a summary, add documents, or decline.'],
            ].map(([Icon, n, t, d], i) => {
              const I = Icon as typeof FileLock2;
              return (
                <motion.div key={n as string} {...reveal} transition={{ ...reveal.transition, delay: i * 0.08 }} className={`flex gap-5 ${i === 1 ? 'md:ml-12' : ''}`}>
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground"><I className="h-5 w-5" /></div>
                  <div>
                    <p className="font-mono text-xs text-muted-foreground">{n as string}</p>
                    <h3 className="font-display text-2xl font-medium">{t as string}</h3>
                    <p className="mt-1.5 max-w-md text-muted-foreground">{d as string}</p>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
        <motion.div {...reveal} className="grid gap-8 rounded-[2rem] bg-primary p-8 text-primary-foreground sm:p-14 md:grid-cols-2">
          <div>
            <h2 className="font-display text-4xl font-medium md:text-5xl">What it will never claim</h2>
            <p className="mt-4 text-primary-foreground/75">Trust comes from being exact. A vault that overstates is worse than none.</p>
          </div>
          <ul className="space-y-4 text-lg">
            {['An uploaded document is not a verified one.', 'A login email is not a background check.', 'A pending check is not a passed check.', 'Where no provider is configured, a check is shown as unavailable.'].map((t) => (
              <li key={t} className="flex gap-3"><Ban className="mt-1 h-5 w-5 shrink-0 text-accent" /><span>{t}</span></li>
            ))}
          </ul>
        </motion.div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-12 px-4 pb-24 sm:px-6 md:grid-cols-2">
        <motion.div {...reveal}>
          <h2 className="font-display text-4xl font-medium md:text-5xl">Consent that is narrow by default.</h2>
          <p className="mt-5 text-lg text-muted-foreground">Every request is its own decision with an expiry and a version, so you never approve something that changed under you.</p>
        </motion.div>
        <div className="space-y-5">
          {[[Eye, 'Summary only, unless you say otherwise', 'Raw documents are a separate tick, document by document.'], [ShieldCheck, 'You confirm the case is yours', 'The employer then binds you to it independently.'], [Undo2, 'Revoke whenever you like', 'One click from your dashboard.']].map(([Icon, t, d], i) => {
            const I = Icon as typeof Eye;
            return (
              <motion.div key={t as string} {...reveal} transition={{ ...reveal.transition, delay: i * 0.08 }} className="flex gap-4 border-b pb-5">
                <I className="mt-1 h-5 w-5 text-primary" />
                <div><h3 className="font-semibold">{t as string}</h3><p className="text-muted-foreground">{d as string}</p></div>
              </motion.div>
            );
          })}
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 pb-24 sm:px-6">
        <h2 className="font-display mb-6 text-4xl font-medium">Plain answers</h2>
        <Accordion type="single" collapsible>
          {faqs.map(([q, a], i) => (
            <AccordionItem key={q} value={`f${i}`}>
              <AccordionTrigger className="text-left text-base font-semibold" data-testid={`faq-${i}`}>{q}</AccordionTrigger>
              <AccordionContent className="text-base leading-relaxed text-muted-foreground">{a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </section>

      <section className="px-4 pb-24 text-center sm:px-6">
        <Mark size={44} />
        <h2 className="font-display mx-auto mt-6 max-w-2xl text-4xl font-medium md:text-6xl">Your record should outlast any one job.</h2>
        <Button asChild size="lg" className="mt-8 h-12 px-8 text-base" data-testid="link-sign-up-footer"><Link href="/sign-up">Create your vault</Link></Button>
      </section>
      <footer className="border-t py-8 text-center text-sm text-muted-foreground">Employee Vault is a personal portfolio. It is not an employer system.</footer>
    </div>
  );
}

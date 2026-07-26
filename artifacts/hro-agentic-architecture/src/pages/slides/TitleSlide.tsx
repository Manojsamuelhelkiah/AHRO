const base = import.meta.env.BASE_URL;

export default function TitleSlide() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <img
        src={`${base}hero-agent-mesh.png`}
        crossOrigin="anonymous"
        alt="Agentic network visualization"
        className="absolute inset-0 w-full h-full object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-[#0a1526] via-[#0a1526]/85 to-[#0a1526]/30" />
      <div className="absolute inset-0 flex flex-col justify-center pl-[7vw] pr-[30vw]">
        <p className="font-body text-accent text-[1.6vw] font-semibold tracking-[0.25em] uppercase">
          Azure &amp; Microsoft Stack
        </p>
        <h1 className="font-display font-bold text-text text-[5.6vw] leading-[1.05] tracking-tight mt-[2.5vh] [text-wrap:balance]">
          Autonomous HRO
        </h1>
        <h2 className="font-display font-medium text-primary text-[3vw] leading-tight mt-[1.5vh]">
          The Agentic Hire-to-Retire Platform
        </h2>
        <p className="font-body text-muted text-[1.9vw] leading-relaxed mt-[4vh] max-w-[42vw] [text-wrap:pretty]">
          An AI-native architecture where digital personas resolve HR work
          end-to-end — with humans in the loop.
        </p>
        <div className="flex items-center gap-[1.2vw] mt-[6vh]">
          <div className="h-[0.4vh] w-[6vw] bg-primary" />
          <div className="h-[0.4vh] w-[2vw] bg-accent" />
          <div className="h-[0.4vh] w-[1vw] bg-muted" />
        </div>
      </div>
    </div>
  );
}

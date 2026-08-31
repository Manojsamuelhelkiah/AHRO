import React from "react";
import { createPortal } from "react-dom";
import { EaAssessment, EaDomain, EaTraceability } from "@workspace/api-client-react";

const EmptySection = () => (
  <div className="text-sm text-gray-500 italic py-2">No records captured</div>
);

const TraceabilityLinks = ({ trace, label }: { trace: EaTraceability, label?: string }) => {
  if (!trace) return null;
  const hasItems = 
    (trace.requirementIds && trace.requirementIds.length > 0) ||
    (trace.gapIds && trace.gapIds.length > 0) ||
    (trace.targetComponentIds && trace.targetComponentIds.length > 0) ||
    (trace.workPackageIds && trace.workPackageIds.length > 0) ||
    (trace.governanceReviewIds && trace.governanceReviewIds.length > 0);

  if (!hasItems) return <span className="text-gray-400 italic">None</span>;

  return (
    <div className="text-xs space-y-0.5">
      {label && <div className="font-semibold">{label}</div>}
      {trace.requirementIds?.length > 0 && <div className="break-words">Reqs: {trace.requirementIds.join(', ')}</div>}
      {trace.gapIds?.length > 0 && <div className="break-words">Gaps: {trace.gapIds.join(', ')}</div>}
      {trace.targetComponentIds?.length > 0 && <div className="break-words">Targets: {trace.targetComponentIds.join(', ')}</div>}
      {trace.workPackageIds?.length > 0 && <div className="break-words">WPs: {trace.workPackageIds.join(', ')}</div>}
      {trace.governanceReviewIds?.length > 0 && <div className="break-words">Gov: {trace.governanceReviewIds.join(', ')}</div>}
    </div>
  );
};

export function PrintableReport({ assessment }: { assessment: EaAssessment }) {
  if (!assessment) return null;
  if (typeof document === "undefined") return null;

  let portal = document.getElementById("print-portal");
  if (!portal) {
    portal = document.createElement("div");
    portal.id = "print-portal";
    document.body.appendChild(portal);
  }
  
  const content = assessment.content;

  return createPortal(
    <div className="print-content hidden print:block text-black bg-white space-y-8 p-8 max-w-5xl mx-auto text-sm">
      {/* cover page / header */}
      <div className="border-b-2 border-black pb-4 mb-8">
        <h1 className="text-4xl font-bold">{assessment.name}</h1>
        <p className="text-xl mt-2 text-gray-600">Enterprise Architecture Assessment for {assessment.clientName}</p>
        <div className="mt-4 flex gap-4 text-sm font-medium">
          <span>Version: {assessment.version}</span>
          <span>Status: {assessment.status}</span>
          <span>Current Phase: {assessment.currentPhase.replace(/-/g, ' ')}</span>
        </div>
      </div>

      {/* Phase Progress */}
      <section className="space-y-4">
        <h2 className="text-2xl font-bold border-b pb-2">Phase Progress</h2>
        {content.phaseProgress.length === 0 ? <EmptySection /> : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-gray-100">
                <th className="border p-2 text-left">Phase</th>
                <th className="border p-2 text-left">Status</th>
                <th className="border p-2 text-right">Completion</th>
                <th className="border p-2 text-left">Notes</th>
              </tr>
            </thead>
            <tbody>
              {content.phaseProgress.map(p => (
                <tr key={p.phase}>
                  <td className="border p-2 capitalize">{p.phase.replace(/-/g, ' ')}</td>
                  <td className="border p-2 capitalize">{p.status.replace(/-/g, ' ')}</td>
                  <td className="border p-2 text-right">{p.completionPercent}%</td>
                  <td className="border p-2">{p.notes || <span className="text-gray-400 italic">No notes</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Current State Domains */}
      <section className="space-y-4 break-before-page">
        <h2 className="text-2xl font-bold border-b pb-2">Current State Inventory</h2>
        {Object.values(EaDomain).map(domain => {
          const items = content.currentState[domain as keyof typeof content.currentState] || [];
          if (items.length === 0) return null;
          return (
            <div key={domain} className="mt-4">
              <h3 className="text-xl font-semibold capitalize mb-2">{domain.replace('-', ' ')} Domain</h3>
              <div className="space-y-4">
                {items.map(item => (
                  <div key={item.id} className="border p-4 rounded bg-gray-50">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <div className="font-bold text-lg">{item.name}</div>
                        <div className="text-xs text-gray-500 font-mono break-all">{item.id}</div>
                      </div>
                      <div className="text-right text-xs space-y-1">
                        <div><span className="font-semibold">Kind:</span> {item.kind}</div>
                        <div><span className="font-semibold">Owner:</span> {item.owner || 'Unassigned'}</div>
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-4 gap-2 mb-3 text-xs">
                      <div className="bg-white p-2 border"><span className="font-semibold block">Maturity</span> {item.maturity}/5</div>
                      <div className="bg-white p-2 border"><span className="font-semibold block">Criticality</span> <span className="capitalize">{item.criticality}</span></div>
                      <div className="bg-white p-2 border"><span className="font-semibold block">Lifecycle</span> <span className="capitalize">{item.lifecycle}</span></div>
                      <div className="bg-white p-2 border"><span className="font-semibold block">Confidence</span> <span className="capitalize">{item.confidence}</span></div>
                    </div>

                    <div className="text-sm mb-3">
                      <div className="font-semibold">Description</div>
                      <div>{item.description || <span className="text-gray-400 italic">None</span>}</div>
                    </div>

                    <div className="text-sm mb-3">
                      <div className="font-semibold">Notes</div>
                      <div>{item.notes || <span className="text-gray-400 italic">None</span>}</div>
                    </div>

                    {item.evidence && item.evidence.length > 0 && (
                      <div className="text-xs">
                        <div className="font-semibold mb-1">Evidence</div>
                        <ul className="list-disc pl-5 space-y-1">
                          {item.evidence.map(e => (
                            <li key={e.id}>
                              <strong>{e.title}</strong> ({e.source})
                              {e.uri && <span className="ml-2 text-blue-600 break-all">{e.uri}</span>}
                              {e.capturedAt && <span className="ml-2 text-gray-500">{new Date(e.capturedAt).toLocaleDateString()}</span>}
                              {e.notes && <div className="text-gray-600 mt-1">{e.notes}</div>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {Object.values(EaDomain).every(domain => (content.currentState[domain as keyof typeof content.currentState] || []).length === 0) && (
          <EmptySection />
        )}
      </section>

      {/* Requirements */}
      <section className="space-y-4 break-before-page">
        <h2 className="text-2xl font-bold border-b pb-2">Requirements</h2>
        {content.requirements.length === 0 ? <EmptySection /> : (
          <div className="space-y-4">
            {content.requirements.map(req => (
              <div key={req.id} className="border p-4 rounded">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="font-bold text-lg">{req.title}</div>
                    <div className="text-xs text-gray-500 font-mono break-all">{req.id}</div>
                  </div>
                  <div className="text-right text-xs space-y-1">
                    <div><span className="font-semibold">Priority:</span> <span className="capitalize">{req.priority}</span></div>
                    <div><span className="font-semibold">Status:</span> <span className="capitalize">{req.status}</span></div>
                    <div><span className="font-semibold">Stakeholder:</span> {req.stakeholder}</div>
                  </div>
                </div>

                <div className="text-sm mb-3">
                  <div className="font-semibold">Description</div>
                  <div>{req.description}</div>
                </div>

                <div className="text-sm mb-3">
                  <div className="font-semibold">Concern</div>
                  <div>{req.concern || <span className="text-gray-400 italic">None</span>}</div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="text-xs">
                    <div className="font-semibold mb-1">Acceptance Criteria</div>
                    {req.acceptanceCriteria?.length > 0 ? (
                      <ul className="list-disc pl-4 space-y-1">
                        {req.acceptanceCriteria.map((ac, idx) => (
                          <li key={idx}>{ac}</li>
                        ))}
                      </ul>
                    ) : <span className="text-gray-400 italic">None</span>}
                  </div>
                  <div className="text-xs border-l pl-4">
                    <div className="font-semibold mb-1">Traceability</div>
                    <TraceabilityLinks trace={req.traceability} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Gaps */}
      <section className="space-y-4 break-before-page">
        <h2 className="text-2xl font-bold border-b pb-2">Gap Register</h2>
        {content.gaps.length === 0 ? <EmptySection /> : (
          <div className="space-y-4">
            {content.gaps.map(gap => (
              <div key={gap.id} className="border p-4 rounded">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="font-bold text-lg">{gap.title}</div>
                    <div className="text-xs text-gray-500 font-mono break-all">{gap.id}</div>
                  </div>
                  <div className="text-right text-xs space-y-1">
                    <div><span className="font-semibold">Domain:</span> <span className="capitalize">{gap.domain}</span></div>
                    <div><span className="font-semibold">Severity:</span> <span className="capitalize">{gap.severity}</span></div>
                    <div><span className="font-semibold">Disposition:</span> <span className="capitalize">{gap.disposition}</span></div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-3 text-sm">
                  <div>
                    <div className="font-semibold">Impact</div>
                    <div>{gap.impact}</div>
                  </div>
                  <div>
                    <div className="font-semibold">Recommendation</div>
                    <div>{gap.recommendation}</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 text-xs border-t pt-2">
                  <div>
                    <div className="font-semibold mb-1">Implementation Dependencies</div>
                    {gap.implementationDependencyIds?.length > 0 ? (
                      <ul className="list-disc pl-4 space-y-1">
                        {gap.implementationDependencyIds.map(depId => (
                          <li key={depId} className="break-all">{depId}</li>
                        ))}
                      </ul>
                    ) : <span className="text-gray-400 italic">None</span>}
                    
                    {gap.targetBuildingBlockId && (
                      <div className="mt-2">
                        <span className="font-semibold">Target Building Block: </span>
                        <span className="break-all">{gap.targetBuildingBlockId}</span>
                      </div>
                    )}
                  </div>
                  <div className="border-l pl-4">
                    <div className="font-semibold mb-1">Traceability</div>
                    <TraceabilityLinks trace={gap.traceability} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Target Architecture */}
      <section className="space-y-4 break-before-page">
        <h2 className="text-2xl font-bold border-b pb-2">Target Architecture</h2>
        
        {content.targetArchitecture.components.length === 0 && content.targetArchitecture.relationships.length === 0 ? <EmptySection /> : (
          <>
            {content.targetArchitecture.components.length > 0 && (
              <div className="mt-4">
                <h3 className="text-xl font-semibold mb-2">Components</h3>
                <div className="space-y-4">
                  {content.targetArchitecture.components.map(comp => (
                    <div key={comp.id} className="border p-4 rounded bg-gray-50">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <div className="font-bold text-lg">{comp.name}</div>
                          <div className="text-xs text-gray-500 font-mono break-all">{comp.id}</div>
                        </div>
                        <div className="text-right text-xs space-y-1">
                          <div><span className="font-semibold">Domain:</span> <span className="capitalize">{comp.domain}</span></div>
                          <div><span className="font-semibold">Type:</span> {comp.componentType}</div>
                          <div><span className="font-semibold">Status:</span> <span className="capitalize">{comp.status}</span></div>
                          <div><span className="font-semibold">Owner:</span> {comp.owner || 'Unassigned'}</div>
                        </div>
                      </div>

                      <div className="text-sm mb-3">
                        <div className="font-semibold">Description</div>
                        <div>{comp.description || <span className="text-gray-400 italic">None</span>}</div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 text-xs border-t pt-2">
                        <div>
                          <div className="font-semibold">Addresses Gaps</div>
                          {comp.addressesGapIds?.length > 0 ? (
                            <ul className="list-disc pl-4 space-y-1">
                              {comp.addressesGapIds.map(id => <li key={id} className="break-all">{id}</li>)}
                            </ul>
                          ) : <span className="text-gray-400 italic">None</span>}
                        </div>
                        <div>
                          <div className="font-semibold">Delivered By Work Packages</div>
                          {comp.deliveredByWorkPackageIds?.length > 0 ? (
                            <ul className="list-disc pl-4 space-y-1">
                              {comp.deliveredByWorkPackageIds.map(id => <li key={id} className="break-all">{id}</li>)}
                            </ul>
                          ) : <span className="text-gray-400 italic">None</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {content.targetArchitecture.relationships.length > 0 && (
              <div className="mt-8">
                <h3 className="text-xl font-semibold mb-2">Relationships</h3>
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="border p-2 text-left w-1/4">Source</th>
                      <th className="border p-2 text-left w-1/6">Type</th>
                      <th className="border p-2 text-left w-1/4">Target</th>
                      <th className="border p-2 text-left">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {content.targetArchitecture.relationships.map(rel => {
                      const source = content.targetArchitecture.components.find(c => c.id === rel.sourceComponentId)?.name || rel.sourceComponentId;
                      const target = content.targetArchitecture.components.find(c => c.id === rel.targetComponentId)?.name || rel.targetComponentId;
                      return (
                        <tr key={rel.id}>
                          <td className="border p-2">
                            <div className="font-medium">{source}</div>
                            <div className="text-[10px] text-gray-500 font-mono break-all">{rel.sourceComponentId}</div>
                          </td>
                          <td className="border p-2 italic">{rel.relationshipType}</td>
                          <td className="border p-2">
                            <div className="font-medium">{target}</div>
                            <div className="text-[10px] text-gray-500 font-mono break-all">{rel.targetComponentId}</div>
                          </td>
                          <td className="border p-2 text-xs">{rel.description}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      {/* Opportunities & Solutions */}
      <section className="space-y-4 break-before-page">
        <h2 className="text-2xl font-bold border-b pb-2">Opportunities & Solutions</h2>
        
        {content.opportunities.solutionOptions.length === 0 && content.opportunities.transitionArchitectures.length === 0 ? <EmptySection /> : (
          <>
            {content.opportunities.solutionOptions.length > 0 && (
              <div className="mt-4">
                <h3 className="text-xl font-semibold mb-2">Solution Options</h3>
                <div className="space-y-4">
                  {content.opportunities.solutionOptions.map(opt => (
                    <div key={opt.id} className="border p-4 rounded">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <div className="font-bold text-lg">{opt.name} {opt.selected && <span className="ml-2 bg-green-100 text-green-800 text-xs px-2 py-1 rounded-full font-bold">Selected</span>}</div>
                          <div className="text-xs text-gray-500 font-mono break-all">{opt.id}</div>
                        </div>
                        <div className="text-right text-xs space-y-1">
                          <div><span className="font-semibold">Approach:</span> <span className="capitalize">{opt.approach}</span></div>
                          <div><span className="font-semibold">Score:</span> {opt.score}</div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 mb-3 text-sm">
                        <div>
                          <div className="font-semibold">Benefits</div>
                          {opt.benefits?.length > 0 ? (
                            <ul className="list-disc pl-4 space-y-1">
                              {opt.benefits.map((b, i) => <li key={i}>{b}</li>)}
                            </ul>
                          ) : <span className="text-gray-400 italic">None</span>}
                        </div>
                        <div>
                          <div className="font-semibold">Constraints</div>
                          {opt.constraints?.length > 0 ? (
                            <ul className="list-disc pl-4 space-y-1">
                              {opt.constraints.map((c, i) => <li key={i}>{c}</li>)}
                            </ul>
                          ) : <span className="text-gray-400 italic">None</span>}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 text-xs bg-gray-50 p-2 rounded">
                        <div>
                          <div className="font-semibold">Mapped Gaps</div>
                          {opt.gapIds?.length > 0 ? <div className="break-all">{opt.gapIds.join(', ')}</div> : <span className="text-gray-400 italic">None</span>}
                        </div>
                        <div>
                          <div className="font-semibold">Mapped Targets</div>
                          {opt.targetComponentIds?.length > 0 ? <div className="break-all">{opt.targetComponentIds.join(', ')}</div> : <span className="text-gray-400 italic">None</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {content.opportunities.transitionArchitectures.length > 0 && (
              <div className="mt-8">
                <h3 className="text-xl font-semibold mb-2">Transition Architectures</h3>
                <div className="space-y-4">
                  {content.opportunities.transitionArchitectures.map(ta => (
                    <div key={ta.id} className="border p-4 rounded bg-gray-50">
                      <div className="font-bold text-lg">{ta.name}</div>
                      <div className="text-xs text-gray-500 font-mono break-all mb-2">{ta.id}</div>
                      
                      <div className="text-sm mb-3">
                        <div className="font-semibold">Description</div>
                        <div>{ta.description || <span className="text-gray-400 italic">None</span>}</div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 mb-3 text-xs border-t pt-2">
                        <div>
                          <div className="font-semibold">Entry Criteria</div>
                          {ta.entryCriteria?.length > 0 ? (
                            <ul className="list-disc pl-4 space-y-1">
                              {ta.entryCriteria.map((c, i) => <li key={i}>{c}</li>)}
                            </ul>
                          ) : <span className="text-gray-400 italic">None</span>}
                        </div>
                        <div>
                          <div className="font-semibold">Exit Criteria</div>
                          {ta.exitCriteria?.length > 0 ? (
                            <ul className="list-disc pl-4 space-y-1">
                              {ta.exitCriteria.map((c, i) => <li key={i}>{c}</li>)}
                            </ul>
                          ) : <span className="text-gray-400 italic">None</span>}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 text-xs border-t pt-2 mt-2">
                        <div>
                          <div className="font-semibold">Mapped Target Components</div>
                          {ta.targetComponentIds?.length > 0 ? <div className="break-all">{ta.targetComponentIds.join(', ')}</div> : <span className="text-gray-400 italic">None</span>}
                        </div>
                        <div>
                          <div className="font-semibold">Mapped Work Packages</div>
                          {ta.workPackageIds?.length > 0 ? <div className="break-all">{ta.workPackageIds.join(', ')}</div> : <span className="text-gray-400 italic">None</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* Roadmap */}
      <section className="space-y-4 break-before-page">
        <h2 className="text-2xl font-bold border-b pb-2">Roadmap & Migration Planning</h2>
        
        {content.roadmap.waves.length === 0 && content.roadmap.workPackages.length === 0 && content.roadmap.dependencies.length === 0 && content.roadmap.prioritization.length === 0 ? <EmptySection /> : (
          <>
            {content.roadmap.waves.length > 0 && (
              <div className="mt-4">
                <h3 className="text-xl font-semibold mb-2">Waves</h3>
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="border p-2 text-left w-16">Seq</th>
                      <th className="border p-2 text-left">Name</th>
                      <th className="border p-2 text-left">Dates</th>
                      <th className="border p-2 text-left">Transition Arch / WPs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {content.roadmap.waves.map(w => (
                      <tr key={w.id}>
                        <td className="border p-2 text-center">{w.sequence}</td>
                        <td className="border p-2">
                          <div className="font-medium">{w.name}</div>
                          <div className="text-[10px] text-gray-500 font-mono break-all">{w.id}</div>
                        </td>
                        <td className="border p-2 text-xs">
                          {w.startDate} - {w.endDate}
                        </td>
                        <td className="border p-2 text-xs">
                          {w.transitionArchitectureId && <div><strong>TA:</strong> <span className="break-all">{w.transitionArchitectureId}</span></div>}
                          {w.workPackageIds?.length > 0 && <div className="mt-1"><strong>WPs:</strong> <span className="break-all">{w.workPackageIds.join(', ')}</span></div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {content.roadmap.workPackages.length > 0 && (
              <div className="mt-8">
                <h3 className="text-xl font-semibold mb-2">Work Packages</h3>
                <div className="space-y-4">
                  {content.roadmap.workPackages.map(wp => {
                    const priority = content.roadmap.prioritization.find(p => p.workPackageId === wp.id);
                    return (
                      <div key={wp.id} className="border p-4 rounded bg-gray-50">
                        <div className="flex justify-between items-start mb-2">
                          <div>
                            <div className="font-bold text-lg">{wp.sequence !== undefined ? `${wp.sequence}. ` : ''}{wp.name}</div>
                            <div className="text-xs text-gray-500 font-mono break-all">{wp.id}</div>
                          </div>
                          <div className="text-right text-xs space-y-1">
                            <div><span className="font-semibold">Phase:</span> <span className="capitalize">{wp.phase.replace(/-/g, ' ')}</span></div>
                            <div><span className="font-semibold">Status:</span> <span className="capitalize">{wp.status}</span></div>
                            <div><span className="font-semibold">Est. Cost:</span> ${wp.estimatedCost.toLocaleString()}</div>
                            <div><span className="font-semibold">Owner:</span> {wp.owner || 'Unassigned'}</div>
                          </div>
                        </div>

                        <div className="text-sm mb-3">
                          <div className="font-semibold">Description</div>
                          <div>{wp.description || <span className="text-gray-400 italic">None</span>}</div>
                        </div>

                        <div className="grid grid-cols-2 gap-4 text-xs mb-3 border-t pt-2">
                          <div>
                            <div className="font-semibold">Outcomes</div>
                            {wp.outcomes?.length > 0 ? (
                              <ul className="list-disc pl-4 space-y-1">
                                {wp.outcomes.map((o, i) => <li key={i}>{o}</li>)}
                              </ul>
                            ) : <span className="text-gray-400 italic">None</span>}
                          </div>
                          <div>
                            <div className="font-semibold">Mapped Targets</div>
                            {wp.targetComponentIds?.length > 0 ? (
                              <div className="break-all">{wp.targetComponentIds.join(', ')}</div>
                            ) : <span className="text-gray-400 italic">None</span>}
                          </div>
                        </div>

                        {priority && (
                          <div className="bg-white p-2 rounded text-xs border">
                            <div className="font-semibold mb-1">Prioritization Score: {priority.totalScore}</div>
                            <div className="grid grid-cols-6 gap-2 mb-2 text-center">
                              <div><span className="block text-gray-500">Value</span> {priority.value}/5</div>
                              <div><span className="block text-gray-500">Risk</span> {priority.risk}/5</div>
                              <div><span className="block text-gray-500">Urgency</span> {priority.urgency}/5</div>
                              <div><span className="block text-gray-500">Dependency</span> {priority.dependency}/5</div>
                              <div><span className="block text-gray-500">Readiness</span> {priority.readiness}/5</div>
                              <div><span className="block text-gray-500">Cost</span> {priority.cost}/5</div>
                            </div>
                            {priority.rationale && (
                              <div className="mt-1 text-gray-700 border-t pt-1"><span className="font-semibold">Rationale:</span> {priority.rationale}</div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {content.roadmap.dependencies.length > 0 && (
              <div className="mt-8">
                <h3 className="text-xl font-semibold mb-2">Dependencies</h3>
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="border p-2 text-left">Predecessor (Source)</th>
                      <th className="border p-2 text-left">Type</th>
                      <th className="border p-2 text-left">Successor (Target)</th>
                      <th className="border p-2 text-left">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {content.roadmap.dependencies.map(d => {
                      const pred = content.roadmap.workPackages.find(w => w.id === d.predecessorWorkPackageId)?.name || d.predecessorWorkPackageId;
                      const succ = content.roadmap.workPackages.find(w => w.id === d.successorWorkPackageId)?.name || d.successorWorkPackageId;
                      return (
                        <tr key={d.id}>
                          <td className="border p-2">
                            <div className="font-medium">{pred}</div>
                            <div className="text-[10px] text-gray-500 font-mono break-all">{d.predecessorWorkPackageId}</div>
                          </td>
                          <td className="border p-2 text-xs italic">{d.dependencyType}</td>
                          <td className="border p-2">
                            <div className="font-medium">{succ}</div>
                            <div className="text-[10px] text-gray-500 font-mono break-all">{d.successorWorkPackageId}</div>
                          </td>
                          <td className="border p-2 text-xs">{d.notes}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      {/* Governance */}
      <section className="space-y-4 break-before-page">
        <h2 className="text-2xl font-bold border-b pb-2">Implementation Governance</h2>
        
        {(!content.governance.contracts.length && !content.governance.reviews.length && !content.governance.deviations.length && !content.governance.waivers.length && !content.governance.remediation.length) ? <EmptySection /> : (
          [
            { label: 'Contracts', items: content.governance.contracts },
            { label: 'Reviews', items: content.governance.reviews },
            { label: 'Deviations', items: content.governance.deviations },
            { label: 'Waivers', items: content.governance.waivers },
            { label: 'Remediation', items: content.governance.remediation }
          ].map(({ label, items }) => {
            if (items.length === 0) return null;
            return (
              <div key={label} className="mt-4">
                <h3 className="text-xl font-semibold mb-2">{label}</h3>
                <div className="space-y-4">
                  {items.map(item => (
                    <div key={item.id} className="border p-4 rounded">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <div className="font-bold text-lg">{item.title}</div>
                          <div className="text-xs text-gray-500 font-mono break-all">{item.id}</div>
                        </div>
                        <div className="text-right text-xs space-y-1">
                          <div><span className="font-semibold">Status:</span> <span className="capitalize">{item.status}</span></div>
                          <div><span className="font-semibold">Due Date:</span> {item.dueDate}</div>
                          <div><span className="font-semibold">Owner:</span> {item.owner || 'Unassigned'}</div>
                        </div>
                      </div>

                      <div className="text-sm mb-3">
                        <div className="font-semibold">Description</div>
                        <div>{item.description || <span className="text-gray-400 italic">None</span>}</div>
                      </div>

                      <div className="grid grid-cols-3 gap-2 text-xs border-t pt-2 bg-gray-50 rounded p-2 mt-2">
                        <div>
                          <div className="font-semibold">Target Components</div>
                          {item.targetComponentIds?.length > 0 ? <div className="break-all">{item.targetComponentIds.join(', ')}</div> : <span className="text-gray-400 italic">None</span>}
                        </div>
                        <div>
                          <div className="font-semibold">Work Packages</div>
                          {item.workPackageIds?.length > 0 ? <div className="break-all">{item.workPackageIds.join(', ')}</div> : <span className="text-gray-400 italic">None</span>}
                        </div>
                        <div>
                          <div className="font-semibold">Decisions</div>
                          {item.decisionIds?.length > 0 ? <div className="break-all">{item.decisionIds.join(', ')}</div> : <span className="text-gray-400 italic">None</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </section>

      {/* Change Management */}
      <section className="space-y-4 break-before-page">
        <h2 className="text-2xl font-bold border-b pb-2">Change Management</h2>
        
        {content.changeManagement.requests.length === 0 && content.changeManagement.versionHistory.length === 0 ? <EmptySection /> : (
          <>
            {content.changeManagement.requests.length > 0 && (
              <div className="mt-4">
                <h3 className="text-xl font-semibold mb-2">Change Requests</h3>
                <div className="space-y-4">
                  {content.changeManagement.requests.map(cr => (
                    <div key={cr.id} className="border p-4 rounded">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <div className="font-bold text-lg">{cr.title}</div>
                          <div className="text-xs text-gray-500 font-mono break-all">{cr.id}</div>
                        </div>
                        <div className="text-right text-xs space-y-1">
                          <div><span className="font-semibold">Requested By:</span> {cr.requestedBy}</div>
                          <div><span className="font-semibold">Status:</span> <span className="capitalize">{cr.status}</span></div>
                          <div><span className="font-semibold">Classification:</span> <span className="capitalize">{cr.classification}</span></div>
                        </div>
                      </div>

                      <div className="text-sm mb-3">
                        <div className="font-semibold">Description</div>
                        <div>{cr.description}</div>
                      </div>

                      <div className="bg-gray-50 p-3 rounded text-xs border">
                        <div className="font-semibold mb-2">Impact Analysis</div>
                        <div className="grid grid-cols-2 gap-4">
                          <div><span className="font-semibold block">Baseline</span>{cr.impact.baseline || '-'}</div>
                          <div><span className="font-semibold block">Target State</span>{cr.impact.targetState || '-'}</div>
                          <div><span className="font-semibold block">Roadmap</span>{cr.impact.roadmap || '-'}</div>
                          <div><span className="font-semibold block">Cost</span>{cr.impact.cost || '-'}</div>
                        </div>
                        {cr.impact.affectedIds?.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-gray-200">
                            <span className="font-semibold block">Affected Elements</span>
                            <div className="break-all">{cr.impact.affectedIds.join(', ')}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {content.changeManagement.versionHistory.length > 0 && (
              <div className="mt-8">
                <h3 className="text-xl font-semibold mb-2">Version History</h3>
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="border p-2 text-left w-20">Version</th>
                      <th className="border p-2 text-left">Description</th>
                      <th className="border p-2 text-left w-1/4">Approval</th>
                      <th className="border p-2 text-left w-1/4">Change Requests</th>
                    </tr>
                  </thead>
                  <tbody>
                    {content.changeManagement.versionHistory.map(vh => (
                      <tr key={vh.id}>
                        <td className="border p-2 font-medium">{vh.version}</td>
                        <td className="border p-2 text-sm">{vh.description}</td>
                        <td className="border p-2 text-xs">
                          <div>{vh.approvedBy}</div>
                          <div className="text-gray-500">{new Date(vh.approvedAt).toLocaleDateString()}</div>
                        </td>
                        <td className="border p-2 text-xs">
                          {vh.changeRequestIds?.length > 0 ? (
                            <div className="break-all">{vh.changeRequestIds.join(', ')}</div>
                          ) : <span className="text-gray-400 italic">None</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      {/* Decisions & Risks */}
      <section className="space-y-4 break-before-page">
        <h2 className="text-2xl font-bold border-b pb-2">Decisions & Risks</h2>
        
        {content.decisions.length === 0 && content.risks.length === 0 ? <EmptySection /> : (
          <>
            {content.decisions.length > 0 && (
              <div className="mt-4">
                <h3 className="text-xl font-semibold mb-2">Decisions</h3>
                <div className="space-y-4">
                  {content.decisions.map(d => (
                    <div key={d.id} className="border p-4 rounded">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <div className="font-bold text-lg">{d.title}</div>
                          <div className="text-xs text-gray-500 font-mono break-all">{d.id}</div>
                        </div>
                        <div className="text-right text-xs space-y-1">
                          <div><span className="font-semibold">Status:</span> <span className="capitalize">{d.status}</span></div>
                          <div><span className="font-semibold">Owner:</span> {d.owner}</div>
                          <div><span className="font-semibold">Date:</span> {new Date(d.decidedAt).toLocaleDateString()}</div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 mb-3 text-sm">
                        <div>
                          <div className="font-semibold">Decision</div>
                          <div>{d.decision}</div>
                        </div>
                        <div>
                          <div className="font-semibold">Rationale</div>
                          <div>{d.rationale}</div>
                        </div>
                      </div>

                      <div className="text-xs border-t pt-2 mt-2">
                        <div className="font-semibold mb-1">Traceability</div>
                        <TraceabilityLinks trace={d.traceability} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {content.risks.length > 0 && (
              <div className="mt-8">
                <h3 className="text-xl font-semibold mb-2">Risks</h3>
                <div className="space-y-4">
                  {content.risks.map(r => (
                    <div key={r.id} className="border p-4 rounded">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <div className="font-bold text-lg">{r.title}</div>
                          <div className="text-xs text-gray-500 font-mono break-all">{r.id}</div>
                        </div>
                        <div className="text-right text-xs space-y-1">
                          <div><span className="font-semibold">Status:</span> <span className="capitalize">{r.status}</span></div>
                          <div><span className="font-semibold">Owner:</span> {r.owner}</div>
                        </div>
                      </div>
                      
                      <div className="flex gap-4 mb-3 text-sm">
                        <div className="bg-gray-100 px-3 py-1 rounded"><span className="font-semibold">Likelihood:</span> {r.likelihood}/5</div>
                        <div className="bg-gray-100 px-3 py-1 rounded"><span className="font-semibold">Impact:</span> {r.impact}/5</div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 text-sm border-t pt-2">
                        <div>
                          <div className="font-semibold">Description</div>
                          <div>{r.description}</div>
                        </div>
                        <div>
                          <div className="font-semibold">Mitigation</div>
                          <div>{r.mitigation}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* Cost Links */}
      <section className="space-y-4 break-before-page">
        <h2 className="text-2xl font-bold border-b pb-2">Cost Model Links</h2>
        {content.costLinks.length === 0 ? <EmptySection /> : (
          <div className="space-y-4">
            {content.costLinks.map(cl => (
              <div key={cl.id} className="border p-4 rounded">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="font-bold text-lg capitalize">{cl.linkType.replace('-', ' ')} Link</div>
                    <div className="text-xs text-gray-500 font-mono break-all">{cl.id}</div>
                  </div>
                  <div className="text-right text-xs space-y-1">
                    <div><span className="font-semibold">Record ID:</span> {cl.linkedRecordId}</div>
                    <div><span className="font-semibold">Created:</span> {new Date(cl.createdAt).toLocaleDateString()}</div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 mb-3 text-xs bg-gray-50 p-2 rounded">
                  <div>
                    <div className="font-semibold">Gaps</div>
                    {cl.gapIds?.length > 0 ? <div className="break-all">{cl.gapIds.join(', ')}</div> : <span className="text-gray-400 italic">None</span>}
                  </div>
                  <div>
                    <div className="font-semibold">Target Components</div>
                    {cl.targetComponentIds?.length > 0 ? <div className="break-all">{cl.targetComponentIds.join(', ')}</div> : <span className="text-gray-400 italic">None</span>}
                  </div>
                  <div>
                    <div className="font-semibold">Work Packages</div>
                    {cl.workPackageIds?.length > 0 ? <div className="break-all">{cl.workPackageIds.join(', ')}</div> : <span className="text-gray-400 italic">None</span>}
                  </div>
                </div>

                {cl.scopeSnapshot && Object.keys(cl.scopeSnapshot).length > 0 && (
                  <div className="text-xs">
                    <div className="font-semibold mb-1">Scope Snapshot</div>
                    <pre className="bg-gray-800 text-white p-2 rounded overflow-auto max-h-40 text-[10px]">
                      {JSON.stringify(cl.scopeSnapshot, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>,
    portal,
  );
}

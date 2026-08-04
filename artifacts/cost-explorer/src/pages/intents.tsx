import { useState, useMemo } from "react";
import { useListIntents } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { Search, Filter, ShieldCheck, Activity, BrainCircuit } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function Intents() {
  const { data: intents, isLoading } = useListIntents();
  const [search, setSearch] = useState("");
  const [domainFilter, setDomainFilter] = useState<string>("all");

  const domains = useMemo(() => {
    if (!intents) return [];
    return Array.from(new Set(intents.map(i => i.domain))).sort();
  }, [intents]);

  const filteredIntents = useMemo(() => {
    if (!intents) return [];
    return intents.filter(intent => {
      const matchesSearch = search === "" || 
        intent.name.toLowerCase().includes(search.toLowerCase()) ||
        intent.description.toLowerCase().includes(search.toLowerCase());
      const matchesDomain = domainFilter === "all" || intent.domain === domainFilter;
      return matchesSearch && matchesDomain;
    });
  }, [intents, search, domainFilter]);

  return (
    <div className="space-y-6 h-full flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Intent Corpus</h1>
          <p className="text-muted-foreground mt-1">Research-backed catalog of HR intents</p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input 
            placeholder="Search intents by name or description..." 
            className="pl-9 bg-card border-border"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="w-full sm:w-[200px]">
          <Select value={domainFilter} onValueChange={setDomainFilter}>
            <SelectTrigger className="bg-card">
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-muted-foreground" />
                <SelectValue placeholder="Filter domain" />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Domains</SelectItem>
              {domains.map(d => (
                <SelectItem key={d} value={d} className="capitalize">{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex-1 overflow-auto -mx-1 px-1 pb-4">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map(i => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredIntents.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                No intents found matching your criteria.
              </div>
            ) : (
              filteredIntents.map((intent) => (
                <Link key={intent.key} href={`/intents/${intent.key}`} className="block group">
                  <Card className="transition-all duration-200 hover:border-primary/40 hover:shadow-md hover:bg-muted/20">
                    <CardContent className="p-5 flex flex-col md:flex-row gap-4 items-start md:items-center">
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold text-lg text-foreground group-hover:text-primary transition-colors">
                            {intent.name}
                          </h3>
                          <Badge variant="secondary" className="capitalize text-xs font-medium">
                            {intent.domain}
                          </Badge>
                          <Badge variant="outline" className="text-xs bg-card font-mono">
                            {intent.flowClass}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground line-clamp-2">
                          {intent.description}
                        </p>
                        
                        <div className="flex items-center gap-4 text-xs pt-1">
                          <div className="flex items-center gap-1.5 text-muted-foreground">
                            <ShieldCheck className="w-3.5 h-3.5" />
                            <span>Source: <span className="font-medium text-foreground/80">{intent.source.name}</span></span>
                            {intent.source.confidence === 'high' && (
                              <span className="w-2 h-2 rounded-full bg-emerald-500 ml-1 inline-block" title="High Confidence" />
                            )}
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-6 md:pl-6 md:border-l border-border min-w-[200px]">
                        <div className="space-y-1">
                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                            <Activity className="w-3.5 h-3.5" /> As-Is Handle
                          </div>
                          <div className="font-mono text-sm font-medium">{intent.asIsHandlingMin} min</div>
                        </div>
                        <div className="space-y-1">
                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                            <BrainCircuit className="w-3.5 h-3.5" /> To-Be Human
                          </div>
                          <div className="font-mono text-sm font-medium">{intent.toBeHumanMin} min</div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

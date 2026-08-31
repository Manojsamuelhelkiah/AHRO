import { useSearch } from "wouter";
import { Portfolio } from "./enterprise-architecture/portfolio";
import { Workspace } from "./enterprise-architecture/workspace";

export default function EnterpriseArchitecture() {
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const idParam = searchParams.get("id");

  if (idParam) {
    return <Workspace id={parseInt(idParam, 10)} />;
  }
  return <Portfolio />;
}

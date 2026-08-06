import HostLobby from "./HostLobby";

export default async function HostPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <HostLobby code={code.toUpperCase()} />;
}

import RoomApp from "./RoomApp";

export default async function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <RoomApp code={code.toUpperCase()} />;
}

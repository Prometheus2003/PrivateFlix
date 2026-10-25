import LibraryApp from "@/components/library-app";
import { getEnv } from "@/lib/validation/env";
export default function Home() {
  return (
    <div
      style={{ "--accent": getEnv().APP_ACCENT_COLOR } as React.CSSProperties}
    >
      <LibraryApp name={getEnv().APP_NAME} />
    </div>
  );
}

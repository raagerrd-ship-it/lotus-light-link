import { User, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { User as AuthUser } from "@supabase/supabase-js";

interface AuthButtonProps {
  user: AuthUser | null;
  loading: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  accent?: string;
}

export default function AuthButton({ user, loading, onSignIn, onSignOut, accent }: AuthButtonProps) {
  if (loading) return null;

  if (user) {
    const avatar = user.user_metadata?.avatar_url;
    return (
      <button
        onClick={onSignOut}
        className="rounded-full w-6 h-6 active:scale-90 transition-transform overflow-hidden flex items-center justify-center"
        title="Logga ut"
        style={{ border: `1.5px solid ${accent ?? 'hsl(var(--foreground) / 0.3)'}` }}
      >
        {avatar ? (
          <img src={avatar} alt="" className="w-full h-full object-cover" />
        ) : (
          <User className="w-3 h-3 text-foreground/70" />
        )}
      </button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onSignIn}
      className="rounded-full w-7 h-7 active:scale-90 transition-transform"
      title="Logga in"
    >
      <User className="w-3.5 h-3.5" />
    </Button>
  );
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Form, Link, NavLink, useLocation } from "react-router";
import { landingPath } from "../auth/landing";
import { ThemeToggle, Wordmark } from "./ui";

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}

function navFor(roles: readonly string[]): NavItem[] {
  const items: NavItem[] = [{ to: "/me", label: "Account" }];
  if (roles.includes("CONVENER")) items.push({ to: "/submissions", label: "My submissions" });
  if (roles.includes("REVIEWER")) items.push({ to: "/review", label: "Review queue" });
  if (roles.includes("SERVER_ROOM_MANAGER")) items.push({ to: "/manager", label: "Server room" });
  if (roles.includes("REVIEWER") || roles.includes("ADMIN")) items.push({ to: "/requests", label: "Access requests" });
  if (roles.includes("ADMIN")) items.push({ to: "/admin", label: "Users" });
  return items;
}

const MenuIcon = ({ open }: { open: boolean }) => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    aria-hidden="true"
  >
    {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
  </svg>
);

/** Top navigation for signed-in pages. Links are shown by role; the server enforces access on every route. */
export function AppHeader({ roles }: { roles: readonly string[] }) {
  const items = navFor(roles);
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const location = useLocation();

  // Close after navigating, and on Escape (returning focus to the toggle).
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="navbar">
      <div className="container-voss">
        <nav className="navbar-inner" aria-label="Main">
          <Wordmark to={landingPath(roles)} />
          <ul className="m-0 ml-4 hidden list-none items-center gap-7 p-0 md:flex">
            {items.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end} className="nav-link">
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <Form method="post" action="/logout" className="hidden md:block">
              <button type="submit" className="btn btn-ghost btn-sm">
                Sign out
              </button>
            </Form>
            <button
              ref={toggle}
              type="button"
              className="icon-btn md:hidden"
              aria-expanded={open}
              aria-controls="mobile-menu"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((o) => !o)}
            >
              <MenuIcon open={open} />
            </button>
          </div>
        </nav>
      </div>
      {open && (
        <div id="mobile-menu" className="mobile-menu md:hidden">
          <ul className="m-0 list-none p-0">
            {items.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end} className="nav-link">
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <Form method="post" action="/logout" className="mt-6">
            <button type="submit" className="btn btn-ghost w-full">
              Sign out
            </button>
          </Form>
        </div>
      )}
    </header>
  );
}

/** Header for signed-out pages (landing, login, errors). */
export function PublicHeader({ action }: { action?: ReactNode }) {
  return (
    <header className="navbar">
      <div className="container-voss">
        <div className="navbar-inner">
          <Wordmark />
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            {action ?? (
              <Link to="/login" className="btn btn-ghost btn-sm">
                Sign in
              </Link>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

/** Signed-in page frame: header, skip-link target, standard container. */
export function AppShell({
  roles,
  children,
  narrow = false,
}: {
  roles: readonly string[];
  children: ReactNode;
  narrow?: boolean;
}) {
  return (
    <>
      <AppHeader roles={roles} />
      <main id="main" tabIndex={-1} className="container-voss page outline-none">
        <div className={narrow ? "page-narrow" : undefined}>{children}</div>
      </main>
    </>
  );
}

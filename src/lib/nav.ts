export interface NavLink {
  label: string;
  href: string;
}

export const navLinks: NavLink[] = [
  { label: "Home", href: "/" },
  { label: "Journal", href: "/journal" },
  { label: "Articles", href: "/articles" },
  { label: "Photography", href: "/photography" },
  { label: "Videos", href: "/videos" },
  { label: "Audio", href: "/audio" },
  { label: "About", href: "/about" },
];

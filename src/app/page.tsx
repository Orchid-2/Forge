import { redirect } from 'next/navigation';

/** The app opens on chat; there is no marketing surface to land on. */
export default function RootPage() {
  redirect('/chat');
}

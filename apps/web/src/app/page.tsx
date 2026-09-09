import { redirect } from 'next/navigation'

// Root page redirects based on auth state
// Auth check happens in middleware
export default function RootPage() {
  redirect('/dashboard')
}

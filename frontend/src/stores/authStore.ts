import { create } from 'zustand'
import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { Profile, UserRole } from '@/types/database'

interface AuthState {
  user: User | null
  profile: Profile | null
  loading: boolean
  initialized: boolean
  setUser: (user: User | null) => void
  setProfile: (profile: Profile | null) => void
  setLoading: (loading: boolean) => void
  initialize: () => Promise<void>
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signUpCustomer: (params: {
    email: string
    password: string
    contactName: string
    businessName: string
    contactPhone: string
    address: string
  }) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  hasRole: (...roles: UserRole[]) => boolean
  canAccessModule: (module: 'dashboard' | 'production' | 'inventory' | 'sales' | 'hr' | 'settings') => boolean
}

// Singleton auth listener: React StrictMode must not create duplicate subscriptions.
let initialization:Promise<void>|null=null
let authSequence=0

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  profile: null,
  loading: true,
  initialized: false,

  setUser: (user) => set({ user }),
  setProfile: (profile) => set({ profile }),
  setLoading: (loading) => set({ loading }),

  initialize: () => {
    if (get().initialized) return Promise.resolve()
    if (initialization) return initialization
    initialization=(async()=>{
      const loadUser=async(user:User|null)=>{
        const sequence=++authSequence
        set({user,profile:null}) // fail closed until role is loaded
        if(!user)return
        const {data,error}=await supabase.from('profiles').select('*').eq('id',user.id).single()
        if(sequence!==authSequence)return // ignore responses from stale sessions
        if(error){console.error('Could not load authorized profile',error.message);set({profile:null});return}
        set({profile:data||null})
      }
      // Register only once, even when initialize() is called by remounts.
      supabase.auth.onAuthStateChange((_event,session)=>{
        // Defer Supabase queries to avoid awaiting another client call while the
        // auth library is holding its internal state-change lock.
        queueMicrotask(()=>{void loadUser(session?.user??null)})
      })
      try {
        const {data,error}=await supabase.auth.getSession()
        if(error)throw error
        await loadUser(data.session?.user??null)
      }catch(error){
        console.error('Authentication initialization failed',error)
        set({user:null,profile:null})
      }finally{set({loading:false,initialized:true})}
    })()
    return initialization
  },

  signIn: async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error?.message ?? null }
  },

  signUpCustomer: async ({ email, password, contactName, businessName, contactPhone, address }) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: contactName,
          role: 'customer',
          business_name: businessName,
          contact_phone: contactPhone,
          address,
        },
      },
    })
    return { error: error?.message ?? null }
  },

  signOut: async () => {
    await supabase.auth.signOut()
    set({ user: null, profile: null })
  },

  hasRole: (...roles) => {
    const { profile } = get()
    return profile ? roles.includes(profile.role) : false
  },

  canAccessModule: (module) => {
    const { profile } = get()
    if (!profile) return false
    const role = profile.role

    if (role === 'admin') return true

    switch (module) {
      case 'dashboard':
        return true
      case 'production':
        return role === 'production_supervisor'
      case 'inventory':
        return ['production_supervisor', 'sales_staff'].includes(role)
      case 'sales':
        return role === 'sales_staff'
      case 'hr':
        return role === 'hr_officer' || role === 'staff'
      case 'settings':
        return false
      default:
        return false
    }
  },
}))

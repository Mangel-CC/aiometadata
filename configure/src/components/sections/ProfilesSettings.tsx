import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Plus, Trash2, Users, EyeOff, Loader2, Link2, Unlink } from 'lucide-react';
import { useConfig } from '@/contexts/ConfigContext';
import type { NuvioProfileSettings } from '@/contexts/config';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Callout } from '@/components/settings/Callout';
import { SettingRow } from '@/components/settings/SettingRow';

// Perfiles: configuraciones hijas que heredan todo de esta (idioma, arte, orden de catalogos) y solo
// cambian las recomendaciones y los catalogos que ocultan. Se guardan al momento, sin el boton de
// guardar, porque cada perfil es su propia fila; lo de este perfil (la principal) si va con guardar.

type ThemeCaps = NonNullable<NuvioProfileSettings['themeCaps']>;

interface ChildProfile {
  uuid: string;
  name: string;
  profileIndex: number | null;
  anime: boolean;
  themeCaps: ThemeCaps | null;
  catalogToggles: Record<string, boolean>;
  manifestUrl: string;
}

interface NuvioState {
  connected: boolean;
  profiles: Array<{ index: number; name: string }>;
  error: string | null;
}

const VARIETY_PRESETS: Record<string, ThemeCaps | null> = {
  normal: null,
  relaxed: { kids: 5, animation: 6, superhero: 4, anime: 4 },
  off: { kids: 10, animation: 10, superhero: 10, anime: 10 },
};

function varietyPreset(caps: ThemeCaps | null | undefined): string {
  if (!caps || !Object.keys(caps).length) return 'normal';
  for (const [key, preset] of Object.entries(VARIETY_PRESETS)) {
    if (preset && JSON.stringify(preset) === JSON.stringify(caps)) return key;
  }
  return 'custom';
}

function VarietySelect({ value, onChange }: { value: ThemeCaps | null | undefined; onChange: (caps: ThemeCaps | null) => void }) {
  const current = varietyPreset(value);
  return (
    <Select value={current} onValueChange={(v) => v !== 'custom' && onChange(VARIETY_PRESETS[v])}>
      <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="normal">Normal (variado)</SelectItem>
        <SelectItem value="relaxed">Más flojo</SelectItem>
        <SelectItem value="off">Sin límites</SelectItem>
        {current === 'custom' && <SelectItem value="custom">Personalizado</SelectItem>}
      </SelectContent>
    </Select>
  );
}

function NuvioProfileSelect({ value, profiles, onChange }: {
  value: number | null | undefined;
  profiles: NuvioState['profiles'];
  onChange: (index: number) => void;
}) {
  const options = profiles.length ? profiles : [1, 2, 3, 4].map((index) => ({ index, name: `Perfil ${index}` }));
  return (
    <Select value={value ? String(value) : ''} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="w-[220px]"><SelectValue placeholder="Elige un perfil" /></SelectTrigger>
      <SelectContent>
        {options.map((p) => (
          <SelectItem key={p.index} value={String(p.index)}>{p.index}. {p.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ProfilesSettings() {
  const { config, setConfig, auth } = useConfig();
  const uuid = auth.authenticated ? auth.userUUID : null;
  const [loading, setLoading] = useState(false);
  const [nuvio, setNuvio] = useState<NuvioState>({ connected: false, profiles: [], error: null });
  const [children, setChildren] = useState<ChildProfile[]>([]);
  const [isChild, setIsChild] = useState(false);
  const [email, setEmail] = useState('');
  const [nuvioPassword, setNuvioPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newIndex, setNewIndex] = useState<number | null>(null);
  const [togglesFor, setTogglesFor] = useState<ChildProfile | null>(null);
  const [deleting, setDeleting] = useState<ChildProfile | null>(null);

  const call = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    const response = await fetch(`/api/profiles/${encodeURIComponent(uuid!)}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, password: auth.password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data?.error || `Error ${response.status}`), { status: response.status });
    return data;
  }, [uuid, auth.password]);

  const refresh = useCallback(async () => {
    if (!uuid) return;
    setLoading(true);
    try {
      const data = await call('list');
      setNuvio(data.nuvio);
      setChildren(data.children);
      setIsChild(false);
    } catch (error: any) {
      if (error?.status === 400 && /perfil/i.test(error.message)) setIsChild(true);
      else toast.error(error.message);
    } finally {
      setLoading(false);
    }
  }, [uuid, call]);

  useEffect(() => { void refresh(); }, [refresh]);

  const updateChild = async (child: ChildProfile, patch: Record<string, unknown>) => {
    setBusy(child.uuid);
    try {
      const data = await call(`update/${child.uuid}`, { patch });
      setChildren((list) => list.map((c) => (c.uuid === child.uuid ? data.child : c)));
      setTogglesFor((open) => (open?.uuid === child.uuid ? data.child : open));
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    setBusy('nuvio');
    try {
      await call('nuvio/connect', { email, nuvioPassword });
      setNuvioPassword('');
      toast.success('Cuenta de Nuvio conectada');
      await refresh();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy('nuvio');
    try {
      await call('nuvio/disconnect');
      toast.success('Cuenta de Nuvio desconectada');
      await refresh();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    setBusy('create');
    try {
      await call('create', { name: newName, profileIndex: newIndex });
      setNewName('');
      setNewIndex(null);
      toast.success('Perfil creado');
      await refresh();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (child: ChildProfile) => {
    setBusy(child.uuid);
    try {
      await call(`delete/${child.uuid}`);
      setChildren((list) => list.filter((c) => c.uuid !== child.uuid));
      toast.success(`Perfil "${child.name}" borrado`);
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(null);
    }
  };

  const setMainNuvio = (patch: Partial<NuvioProfileSettings>) => {
    setConfig((prev) => {
      const next: NuvioProfileSettings = { ...(prev.nuvio || {}), ...patch };
      if (next.anime !== false) delete next.anime;
      if (!next.themeCaps) delete next.themeCaps;
      return { ...prev, nuvio: next };
    });
  };

  if (!uuid) {
    return (
      <div className="space-y-6">
        <Header />
        <Callout variant="info">Guarda la configuración primero; los perfiles se crean a partir de una configuración guardada.</Callout>
      </div>
    );
  }

  if (isChild) {
    return (
      <div className="space-y-6">
        <Header />
        <Callout variant="info">Esta configuración es un perfil. Los perfiles se administran desde la configuración principal.</Callout>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Cuenta de Nuvio
            {nuvio.connected ? <Badge variant="secondary">Conectada</Badge> : <Badge variant="outline">Sin conectar</Badge>}
          </CardTitle>
          <CardDescription>
            De aquí sale el historial de cada perfil para las recomendaciones. Solo se guarda la sesión, nunca la contraseña.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {nuvio.connected ? (
            <>
              {nuvio.error && <Callout variant="warn">{nuvio.error}</Callout>}
              {nuvio.profiles.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  Perfiles en Nuvio: {nuvio.profiles.map((p) => `${p.index}. ${p.name}`).join(' · ')}
                </p>
              )}
              <Button variant="outline" size="sm" onClick={disconnect} disabled={busy === 'nuvio'}>
                <Unlink className="h-4 w-4 mr-2" /> Desconectar
              </Button>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Input className="w-[240px]" type="email" placeholder="Correo de Nuvio" value={email} onChange={(e) => setEmail(e.target.value)} />
              <Input className="w-[200px]" type="password" placeholder="Contraseña" value={nuvioPassword} onChange={(e) => setNuvioPassword(e.target.value)} />
              <Button onClick={connect} disabled={!email || !nuvioPassword || busy === 'nuvio'}>
                {busy === 'nuvio' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Link2 className="h-4 w-4 mr-2" />} Conectar
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Esta configuración</CardTitle>
          <CardDescription>Las recomendaciones de la configuración principal. Estos cambios se aplican con el botón de guardar.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          <SettingRow
            label="Perfil de Nuvio"
            description="De qué perfil se toma el historial."
            control={<NuvioProfileSelect value={config.nuvio?.profileIndex ?? 1} profiles={nuvio.profiles} onChange={(i) => setMainNuvio({ profileIndex: i })} />}
          />
          <SettingRow
            label="Anime recomendado"
            description="Muestra el catálogo “Anime recomendado para ti”."
            control={<Switch checked={config.nuvio?.anime !== false} onCheckedChange={(v) => setMainNuvio({ anime: v })} />}
          />
          <SettingRow
            label="Variedad"
            description="Cuánto se reparten superhéroes, animación, infantil y anime en cada bloque de 10."
            control={<VarietySelect value={config.nuvio?.themeCaps} onChange={(caps) => setMainNuvio({ themeCaps: caps })} />}
          />
        </CardContent>
      </Card>

      {loading && children.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Cargando perfiles…</div>
      ) : (
        children.map((child) => (
          <ChildCard
            key={child.uuid}
            child={child}
            profiles={nuvio.profiles}
            busy={busy === child.uuid}
            onUpdate={(patch) => updateChild(child, patch)}
            onToggles={() => setTogglesFor(child)}
            onDelete={() => setDeleting(child)}
          />
        ))
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Plus className="h-4 w-4" /> Agregar perfil</CardTitle>
          <CardDescription>Hereda todo de esta configuración y entra con la misma contraseña.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Input className="w-[220px]" placeholder="Nombre" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <NuvioProfileSelect value={newIndex} profiles={nuvio.profiles} onChange={setNewIndex} />
          <Button onClick={create} disabled={!newName.trim() || busy === 'create'}>
            {busy === 'create' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />} Crear
          </Button>
        </CardContent>
      </Card>

      {togglesFor && (
        <CatalogTogglesDialog
          child={togglesFor}
          catalogs={config.catalogs || []}
          onClose={() => setTogglesFor(null)}
          onSave={(toggles) => updateChild(togglesFor, { catalogToggles: toggles })}
        />
      )}

      <ConfirmDialog
        isOpen={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => { if (deleting) void remove(deleting); setDeleting(null); }}
        title={`¿Borrar el perfil "${deleting?.name ?? ''}"?`}
        description="Su URL del addon deja de funcionar. Quien lo tenga instalado tendrá que instalar otro."
        confirmText="Borrar"
        variant="destructive"
      />
    </div>
  );
}

function Header() {
  return (
    <div>
      <h2 className="text-2xl font-semibold flex items-center gap-2"><Users className="h-6 w-6" /> Perfiles</h2>
      <p className="text-muted-foreground mt-1">
        Una configuración por persona que sigue a esta: idioma, arte y orden de catálogos se cambian una sola vez aquí.
        Cada perfil tiene sus propias recomendaciones de Nuvio y puede ocultar catálogos.
      </p>
    </div>
  );
}

function ChildCard({ child, profiles, busy, onUpdate, onToggles, onDelete }: {
  child: ChildProfile;
  profiles: NuvioState['profiles'];
  busy: boolean;
  onUpdate: (patch: Record<string, unknown>) => void;
  onToggles: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(child.name);
  useEffect(() => setName(child.name), [child.name]);
  const hidden = Object.values(child.catalogToggles).filter((v) => v === false).length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(child.manifestUrl);
      toast.success('URL copiada');
    } catch {
      toast.error('No se pudo copiar');
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Input
              className="w-[220px] font-semibold"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && name.trim() !== child.name && onUpdate({ name: name.trim() })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
          <Button variant="ghost" size="sm" className="text-destructive" onClick={onDelete}>
            <Trash2 className="h-4 w-4 mr-1" /> Borrar
          </Button>
        </div>
      </CardHeader>
      <CardContent className="divide-y divide-border">
        <SettingRow
          label="Perfil de Nuvio"
          description="De qué perfil se toma el historial."
          control={<NuvioProfileSelect value={child.profileIndex} profiles={profiles} onChange={(i) => onUpdate({ profileIndex: i })} />}
        />
        <SettingRow
          label="Anime recomendado"
          description="Muestra el catálogo “Anime recomendado para ti”."
          control={<Switch checked={child.anime} onCheckedChange={(v) => onUpdate({ anime: v })} />}
        />
        <SettingRow
          label="Variedad"
          description="Cuánto se reparten superhéroes, animación, infantil y anime en cada bloque de 10."
          control={<VarietySelect value={child.themeCaps} onChange={(caps) => onUpdate({ themeCaps: caps })} />}
        />
        <SettingRow
          label="Catálogos ocultos"
          description={hidden ? `${hidden} catálogo${hidden === 1 ? '' : 's'} oculto${hidden === 1 ? '' : 's'} en este perfil.` : 'Ve los mismos catálogos que esta configuración.'}
          control={<Button variant="outline" size="sm" onClick={onToggles}><EyeOff className="h-4 w-4 mr-2" /> Elegir</Button>}
        />
        <SettingRow
          label="URL del addon"
          description={<span className="break-all font-mono text-xs">{child.manifestUrl}</span>}
          control={<Button variant="outline" size="sm" onClick={copy}><Copy className="h-4 w-4 mr-2" /> Copiar</Button>}
        />
      </CardContent>
    </Card>
  );
}

function CatalogTogglesDialog({ child, catalogs, onClose, onSave }: {
  child: ChildProfile;
  catalogs: Array<{ id: string; type: string; name: string; enabled: boolean }>;
  onClose: () => void;
  onSave: (toggles: Record<string, boolean>) => void;
}) {
  const [query, setQuery] = useState('');
  const [toggles, setToggles] = useState<Record<string, boolean>>(child.catalogToggles || {});
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalogs.filter((c) => c.enabled && (!q || c.name.toLowerCase().includes(q)));
  }, [catalogs, query]);

  const keyOf = (c: { id: string; type: string }) => `${c.id}:${c.type}`;
  const isShown = (c: { id: string; type: string }) => toggles[keyOf(c)] ?? toggles[c.id] ?? true;
  const setShown = (c: { id: string; type: string }, shown: boolean) => {
    setToggles((prev) => {
      const next = { ...prev };
      delete next[c.id];
      if (shown) delete next[keyOf(c)]; else next[keyOf(c)] = false;
      return next;
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Catálogos de {child.name}</DialogTitle>
          <DialogDescription>Apaga los que este perfil no debe ver. El orden lo sigue poniendo la configuración principal.</DialogDescription>
        </DialogHeader>
        <Input placeholder="Buscar catálogo…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="flex-1 overflow-y-auto divide-y divide-border -mx-1 px-1">
          {visible.map((c) => (
            <label key={keyOf(c)} className="flex items-center justify-between gap-3 py-2 text-sm cursor-pointer">
              <span className="min-w-0 truncate">{c.name} <span className="text-muted-foreground">({c.type})</span></span>
              <Switch checked={isShown(c)} onCheckedChange={(v) => setShown(c, v)} />
            </label>
          ))}
          {visible.length === 0 && <p className="py-4 text-sm text-muted-foreground">Nada coincide.</p>}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => { onSave(toggles); onClose(); }}>Guardar</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

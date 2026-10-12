import { SAMPLE_MATERIALS } from '../public/sample.js';
import { samplePpt, sampleActivities } from './samples.js';
import { createResource, currentVersion } from './workspace.js';
import { AppError, id } from './store.js';
import { MAX_MATERIALS, MAX_TOTAL_CHARACTERS } from './uploadPolicy.js';

const materials = Object.entries(SAMPLE_MATERIALS).map(([type, content]) => ({ sampleKey: 'sorting-material-' + type, type, content, title: '排序课程示例资料 · ' + type }));
const resources = [
  { sampleKey: 'sorting-ppt', type: 'ppt', name: '排序课程 · 本地示例 PPT', content: samplePpt },
  ...sampleActivities.map(content => ({ sampleKey: 'sorting-' + content.mode, type: content.mode === 'steps' ? 'web' : 'game', name: content.title, content })),
];
// Slide IDs and confirmation status are generated after loading the fixture.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter(k => !['id', 'status', 'paginationRootId'].includes(k)).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const sameContent = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function resourceSample(resource) {
  if (resource.origin !== 'sample') return;
  return resources.find(sample => sample.type === resource.type && (sample.sampleKey === resource.sampleKey || resource.versions[0]?.source === 'sample' && sameContent(resource.versions[0].content, sample.content)));
}
function untouched(resource, sample) {
  const version = currentVersion(resource);
  return resource.versions.length === 1 && version?.source === 'sample' && resource.name === sample.name && !version.confirmed
    && !version.content.slides?.some(s => s.status === 'confirmed') && sameContent(version.content, sample.content);
}

// Add only missing fixtures. Legacy copies are recognized from their original
// sample version, so renamed/edited copies still count as an existing sample.
export function loadSampleWorkspace(state) {
  const report = { addedMaterials: 0, addedResources: 0, removedMaterials: 0, removedResources: 0 };
  const materialGroups = new Map();
  state.materials = state.materials.filter(material => {
    const sample = material.source === 'sample' && material.status === 'parsed' && materials.find(s => s.sampleKey === material.sampleKey || s.type === material.type && s.title === material.title && s.content === material.content);
    if (!sample) return true;
    material.sampleKey = sample.sampleKey;
    const signature = JSON.stringify([sample.sampleKey, material.type, material.title, material.content]);
    if (materialGroups.has(signature)) { report.removedMaterials++; return false; }
    materialGroups.set(signature, material); return true;
  });
  const referenced = new Set(state.messages.map(m => m.resourceId).filter(Boolean));
  for (const resource of state.resources) for (const version of resource.versions) for (const slide of version.content.slides || []) if (slide.attachment?.resourceId) referenced.add(slide.attachment.resourceId);
  const resourceGroups = new Map();
  for (const resource of state.resources) {
    const sample = resourceSample(resource); if (!sample) continue;
    resource.sampleKey = sample.sampleKey;
    if (!resourceGroups.has(sample.sampleKey)) resourceGroups.set(sample.sampleKey, []);
    resourceGroups.get(sample.sampleKey).push({ resource, sample });
  }
  const remove = new Set();
  for (const group of resourceGroups.values()) {
    const protectedEntries = group.filter(({ resource, sample }) => resource.id === state.selectedId || referenced.has(resource.id) || !untouched(resource, sample));
    const keep = new Set((protectedEntries.length ? protectedEntries : group.slice(0, 1)).map(({ resource }) => resource.id));
    for (const { resource } of group) if (!keep.has(resource.id)) remove.add(resource.id);
  }
  state.resources = state.resources.filter(r => !remove.has(r.id)); report.removedResources = remove.size;
  const missingMaterials = materials.filter(s => !state.materials.some(m => m.source === 'sample' && m.sampleKey === s.sampleKey));
  const missingResources = resources.filter(s => !state.resources.some(r => r.origin === 'sample' && r.sampleKey === s.sampleKey));
  if (state.materials.length + missingMaterials.length > MAX_MATERIALS || state.resources.length + missingResources.length > 60) throw new AppError('补充缺少的示例会超过资料或资源数量限制，请先清理不需要的内容。');
  if (state.materials.reduce((n, m) => n + m.content.length, 0) + missingMaterials.reduce((n, s) => n + s.content.length, 0) > MAX_TOTAL_CHARACTERS) throw new AppError('补充示例会使资料正文合计超过 500000 字符，请先移除或精简资料。');
  for (const sample of missingMaterials) state.materials.push({ ...sample, id: id(), status: 'parsed', source: 'sample' });
  const selectedId = state.selectedId;
  for (const sample of missingResources) createResource(state, sample.type, sample.name, sample.content, 'sample').sampleKey = sample.sampleKey;
  if (selectedId && state.resources.some(r => r.id === selectedId)) state.selectedId = selectedId;
  report.addedMaterials = missingMaterials.length; report.addedResources = missingResources.length;
  if (missingMaterials.length) { state.analysis = null; state.analysisSource = null; state.analysisWarning = ''; state.supplements = []; }
  if (report.addedMaterials || report.addedResources || report.removedMaterials || report.removedResources) state.messages.push({ id: id(), role: 'assistant', text: `已补充 ${report.addedMaterials} 份示例资料、${report.addedResources} 份示例资源；整理 ${report.removedMaterials} 份重复资料、${report.removedResources} 份未修改的重复资源。已有修改和引用保留，未调用 AI。`, status: 'complete' });
  return report;
}

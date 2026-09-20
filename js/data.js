export const DEFAULT_BRAND = { text: 'اسمي', tagline: 'شعاري', color: '#00e5ff', accent: '#ff2bd6', font: 'Orbitron' };

export const DEFAULT_CV = {
  name: 'الاسم الكامل',
  title: 'المسمى الوظيفي',
  summary: 'سطران عن نفسك.',
  experience: [{ role: 'المنصب', company: 'الشركة', period: '2022 — الآن', points: ['إنجاز 1', 'إنجاز 2'] }],
  skills: [{ group: 'المجال', items: ['مهارة', 'مهارة'] }],
  projects: [{ name: 'المشروع', desc: 'وصف', tags: ['وسم'], link: 'https://…' }],
  contact: { email: '', phone: '', location: '', links: [{ label: 'LinkedIn', url: '' }] },
};

export const SECTIONS = [
  { id: 'experience', label: 'Experience', icon: '◆' },
  { id: 'skills', label: 'Skills', icon: '◈' },
  { id: 'projects', label: 'Projects', icon: '◇' },
  { id: 'contact', label: 'Contact', icon: '◎' },
];

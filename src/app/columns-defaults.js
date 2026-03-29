/** Spalten-IDs, die fest ins System gehören (nicht löschbar wie normale Kategorien). */
export const SYSTEM_COLUMN_IDS = ['title', 'internalLinks', 'notes', 'createdBy'];

/** Standard-Kategorien/Spalten für neue Nutzer oder nach Reset. */
export function defaultColumns() {
  return [
    { id:'title',    name:'Titel',       type:'text',        visible:true,  locked:true },
    { id:'format',   name:'Format',      type:'select',      visible:true,
      options:[
        {label:'Page',  color:'#2f9e44'},
        {label:'Video', color:'#222222'}
      ]},
    { id:'topic',    name:'Plattform',   type:'multiselect', visible:true,
      options:[
        {label:'Youtube',  color:'#e03131'},
        {label:'LinkedIn', color:'#1971c2'},
        {label:'Website',  color:'#2f9e44'},
        {label:'Reddit',   color:'#e8590c'}
      ]},
    { id:'phase',    name:'Keywords',    type:'multiselect', visible:true,
      options:[
        {label:'Core',           color:'#868e96'},
        {label:'Produkt',        color:'#2f9e44'},
        {label:'Branche',        color:'#1971c2'},
        {label:'Blog',           color:'#e67700'},
        {label:'Lead-Gen',       color:'#9b4dca'},
        {label:'Content',        color:'#e8590c'},
        {label:'Unternehmen',    color:'#6741d9'},
        {label:'Customer Center',color:'#495057'},
        {label:'Kontakt',        color:'#2f9e44'},
        {label:'ModSPOT',        color:'#e8590c'},
        {label:'ModOFFICE',      color:'#40c057'},
        {label:'ModHYL',         color:'#c0eb75'},
        {label:'ACR',            color:'#cc5de8'},
        {label:'Werkerführung',  color:'#5c7cfa'},
        {label:'KI',             color:'#40c057'},
        {label:'ModPCB',         color:'#74c0fc'}
      ]},
    { id:'owner',    name:'Verantw.',    type:'select',      visible:true,
      options:[
        {label:'Frederick W', color:'#868e96'},
        {label:'Thomas M',    color:'#868e96'}
      ]},
    { id:'date',     name:'Datum',       type:'date',        visible:true  },
    { id:'internalLinks', name:'Links',  type:'links',       visible:true,  locked:true },
    { id:'persona',  name:'Speicherort', type:'text',        visible:true  },
    { id:'url',      name:'URL',         type:'url',         visible:false },
    { id:'notes',    name:'Notizen',     type:'text',        visible:false, locked:true },
    { id:'createdBy',name:'Erstellt von',type:'text',        visible:false, locked:true, system:true },
  ];
}

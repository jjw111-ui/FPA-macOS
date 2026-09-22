
const state = {
      images: [], activeImageId: null, primaryImageId: null,
      annotations: [], selectedAnnotationId: null,
      tool: 'box', drawing: null, color: '',
      styleImages: { fabric: null, color: null },
      styleModes: { fabric: 'primary', color: 'auto' }
    };

    const $ = (id) => document.getElementById(id);
function activeImage() { return state.images.find(x => x.id === state.activeImageId); }
function selectedAnn() { return state.annotations.find(x => x.id === state.selectedAnnotationId); }
    function modeLabel(mode) { return ({retain:'严格保留',adapt:'借鉴并调整',mood:'视觉借鉴'})[mode]; }
    function priorityLabel(p) { return ({low:'低',medium:'中',high:'高'})[p]; }
    function inheritLabel(v, kind) { return v==='retain'?`保留原${kind}`:v==='adapt'?`转译到目标${kind}`:`忽略原${kind}`; }

    function compileData() {
      const primary = state.images.find(x=>x.id===state.primaryImageId);
      const style = getDesignStyle();
      const value = id => String($(id)?.value || '').trim();
      const regions = state.annotations.map((annotation, index) => {
        const image = state.images.find(item => item.id === annotation.imageId);
        return {
          index: index + 1,
          reference_label: `R${state.images.findIndex(item => item.id === annotation.imageId) + 1}.${state.annotations.filter(item => item.imageId === annotation.imageId).findIndex(item => item.id === annotation.id) + 1}`,
          source_image: image ? { image_id:image.id, file_name:image.name } : null,
          source_region: { x:+annotation.x.toFixed(3), y:+annotation.y.toFixed(3), w:+annotation.w.toFixed(3), h:+annotation.h.toFixed(3) },
          identified_detail: annotation.part,
          target_area: annotation.placement,
          influence_mode: modeLabel(annotation.mode),
          priority: priorityLabel(annotation.priority),
          color_handling: inheritLabel(annotation.color, '颜色'),
          material_handling: inheritLabel(annotation.fabric, '面料'),
          design_instruction: annotation.note
        };
      });
      const sourceImages = state.images.map(image => ({
        image_id: image.id,
        file_name: image.name,
        role: image.id === state.primaryImageId ? '主体款式参考' : '局部细节参考',
        influence_scope: image.id === state.primaryImageId ? '整体廓形、长度、肩部松量和服装骨架' : '仅限于该图片中被框选并识别的局部区域'
      })).concat(getStyleReferences().map(image => ({
        image_id: image.id, file_name: image.name, role: image.role,
        influence_scope: image.role === '面料参考' ? `参考面料材质、纹理、面料自身的印花或织纹图案和垂坠表现；${style.color.mode==='auto'?'同时采用面料真实颜色':'颜色按明确指定的配色来源处理'}。不参考服装款式、人物、背景或布样边缘形状` : '仅参考配色，不参考服装款式、人物、背景或面料结构'
      })));
      const annotatedSummary = regions.length ? regions.map(region => `${region.identified_detail}（来自图片“${region.source_image?.file_name || '未知图片'}”，应用于${region.target_area}，${region.influence_mode}）`).join('；') : '当前尚未添加局部细节影响。';
      const materialTarget = style.fabric.mode === 'primary' ? '沿用主体款式参考的面料，不强制替换材质'
        : style.fabric.mode === 'image' ? '使用面料参考图的材质、纹理、面料自身图案与质感，保持主体款式结构' : style.fabric.text || '待填写面料说明';
      const colorTarget = style.color.mode === 'auto' ? style.fabric.mode==='image'
        ? '采用面料参考图的真实颜色；默认统一应用于衣身、袖子、领口和口袋等所有面料部位，保留结构与分割线，不保留主体款式原有撞色色块。面料说明明确限定的应用范围或局部 color=retain 设置除外。'
        : '未启用面料图片，沿用主体款式参考的配色，不添加默认颜色'
        : style.color.mode === 'primary' ? '用户明确指定沿用主体款式参考的配色，覆盖面料图颜色'
        : style.color.mode === 'image' ? '使用配色参考图中的颜色关系，不复制该图的款式或背景'
          : style.color.mode === 'custom' ? `使用指定颜色 ${style.color.hex || '（待选择）'}` : style.color.text || '待填写配色说明';
      const promptMain = `Create one original ${value('category') || 'garment based on the primary reference'} as a single complete garment product image. Use “${primary?.name || 'the selected primary reference'}” as the source for the overall garment architecture, including silhouette, length, shoulder ease, body proportion, and center-front construction. The design is influenced by these explicitly mapped references: ${annotatedSummary} Apply each influence only to its mapped target area; do not copy unannotated parts, branding, styling, background, model, or unrelated construction. Fabric and colors must follow the selected style settings: ${materialTarget}; ${colorTarget}. Fabric and color reference images never control garment construction. ${value('goal') ? `Design objective: ${value('goal')}. ` : ''}Show one complete front-facing garment on a clean neutral studio background.`;
      const keywordList = [value('category'), value('fit'), style.color.mode === 'custom' ? style.color.hex : '', ...regions.map(region => region.identified_detail).filter(part => !['识别中…','其他结构'].includes(part))].filter(Boolean);
      return {
        version: '1.0-fpa-design-workbench',
        garment_profile_compact: {
          source_references: sourceImages,
          style_settings: style,
          basic_info: {
            type: value('category') || '沿用主体款式品类',
            ...(value('goal') ? { style: value('goal') } : {}),
            view: '正面单件服装产品图',
            primary_reference: primary ? { image_id:primary.id, file_name:primary.name, influence:'整体款式骨架' } : null
          },
          silhouette: {
            fit: value('fit') || '沿用主体款式版型',
            length: primary ? '参考主体款式的整体长度，并按目标版型调整' : '待主体参考图确定',
            shoulder: primary ? '参考主体款式的肩部松量与肩线关系' : '待主体参考图确定',
            proportions: primary ? '保持主体款式的整体比例逻辑，避免局部参考改变整件服装骨架' : '按品类与版型设定生成'
          },
          materials: {
            main_fabric: materialTarget,
            ...(style.fabric.text ? { instruction: style.fabric.text } : {}),
            secondary_fabric: regions.filter(region => region.material_handling !== '忽略原面料').map(region => `${region.identified_detail}：${region.material_handling}`).join('；') || '无额外局部面料要求',
            surface: '按当前面料模式处理；局部参考只在明确指定时影响材质表现'
          },
          colors: {
            target: colorTarget,
            ...(style.color.text ? { instruction: style.color.text } : {}),
            ...(style.color.hex ? { hex: style.color.hex } : {}),
            ...(value('colorRatio') ? { strategy: value('colorRatio') } : {}),
            focal_point: regions.length ? `突出${regions.map(region => region.identified_detail).join('、')}等已标注细节` : '突出整体廓形与面料质感'
          },
          key_details: {
            annotated_regions: regions
          },
          special_features: {
            reference_influence_count: regions.length,
            reference_influences: regions,
            rule: '每张参考图只影响其明确指定的整体范围或框选局部，不复制未标注内容'
          },
          hardware: {
            finish: value('hardware') || '沿用主体款式五金，不添加默认五金颜色',
            reference_impact: '仅在局部标注明确要求继承时采用参考图五金细节'
          },
          critical_rules: {
            must_have: [$('mustKeep').value, ...regions.filter(region => region.priority === '高').map(region => `${region.identified_detail}：${region.design_instruction}`)].filter(Boolean),
            must_avoid: [$('avoid').value, '不要生成拼贴、分屏、背面小图或多件服装'].filter(Boolean)
          },
          prompt_output: {
            main: promptMain,
            negative: $('avoid').value,
            keywords: [...new Set(keywordList)].join(', ')
          }
        }
      };
    }

    function compilePrompt(data) {
      return JSON.stringify(data.garment_profile_compact, null, 2);
    }
  

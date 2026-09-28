(() => {
  const config = window.SAJDA_SUPABASE_CONFIG;
  const sdk = window.supabase;
  const client = config && sdk?.createClient
    ? sdk.createClient(config.url, config.publishableKey, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
    })
    : null;

  function requireClient() {
    if (!client) throw new Error('تعذر تحميل اتصال قاعدة البيانات. تحققي من الاتصال بالإنترنت وإعداد Supabase.');
    return client;
  }
  async function checked(query) {
    const result = await query;
    if (result.error) throw result.error;
    return result.data;
  }
  function publicAsset(path) {
    if (!path) return '';
    if (/^(https?:|data:)/i.test(path)) return path;
    return requireClient().storage.from('store-assets').getPublicUrl(path).data.publicUrl;
  }
  function mapProduct(row) {
    return {
      id: row.id, name: row.name, category: row.category, price: Number(row.price),
      details: row.details || '', image: publicAsset(row.image_path),
      colors: (row.colors || []).map(color => ({ ...color, image: publicAsset(color.image) }))
    };
  }
  function mapSettings(row) {
    return {
      title: row.title, subtitle: row.subtitle, banner: publicAsset(row.banner_path),
      logo: publicAsset(row.logo_path), shipping: Number(row.shipping),
      deposit: Number(row.deposit), wheel: { enabled: row.wheel_enabled, prizes: row.wheel_prizes }
    };
  }
  async function uploadAsset(value, folder) {
    if (!value) return null;
    if (/^https?:/i.test(value)) return value;
    let blob;
    if (value instanceof File || value instanceof Blob) blob = value;
    else if (String(value).startsWith('data:')) {
      const response = await fetch(value);
      blob = await response.blob();
    } else return value;
    const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[blob.type];
    if (!extension) throw new Error('استخدمي صورة بصيغة JPG أو PNG أو WebP.');
    if (blob.size > 2 * 1024 * 1024) throw new Error('حجم الصورة يجب ألا يتجاوز 2 ميجابايت.');
    const path = `${folder}/${crypto.randomUUID()}.${extension}`;
    const saved = await checked(requireClient().storage.from('store-assets').upload(path, blob, {
      contentType: blob.type, upsert: false
    }));
    return saved.path;
  }
  const backend = {
    configured: Boolean(client),
    async loadPublic(state) {
      const db = requireClient();
      const [products, promos, reviews, visitors, forum, settings] = await Promise.all([
        checked(db.from('sajda_products').select('*').order('updated_at', { ascending: false })),
        checked(db.from('sajda_promos').select('*')),
        checked(db.from('sajda_reviews').select('*').order('created_at', { ascending: false })),
        Promise.resolve([]),
        checked(db.from('sajda_forum').select('*').order('created_at', { ascending: false })),
        checked(db.from('sajda_settings').select('*').eq('id', true).single())
      ]);
      state.products = products.map(mapProduct);
      state.promo = Object.fromEntries(promos.map(p => [p.product_id, { price: Number(p.price) }]));
      state.reviews = reviews.map(r => ({
        id: r.id, name: r.name, stars: r.stars, text: r.review_text, date: r.created_at
      }));
      state.forum = forum.map(f => ({ id: f.id, name: f.name, text: f.post_text, date: f.created_at }));
      state.settings = { ...state.settings, ...mapSettings(settings) };
      state.offers = { shipping: Number(settings.shipping), deposit: Number(settings.deposit) };
      state.wheel = { enabled: settings.wheel_enabled, prizes: settings.wheel_prizes || [] };
      state.visitors = visitors;
      state.orders = [];
      state.chats = [];
    },
    async trackVisitor(name, sessionId) {
      return checked(requireClient().from('sajda_visitors').upsert({
        name, session_id: sessionId
      }, { onConflict: 'session_id', ignoreDuplicates: true }));
    },
    async submitOrder(order, proofFile) {
      const db = requireClient();
      let proofPath = null;
      if (proofFile?.size) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(proofFile.type)) {
          throw new Error('صورة التحويل يجب أن تكون بصيغة JPG أو PNG أو WebP.');
        }
        if (proofFile.size > 2 * 1024 * 1024) throw new Error('حجم صورة التحويل يجب ألا يتجاوز 2 ميجابايت.');
        proofPath = `incoming/${crypto.randomUUID()}.${proofFile.type.split('/')[1].replace('jpeg', 'jpg')}`;
        await checked(db.storage.from('order-proofs').upload(proofPath, proofFile, {
          contentType: proofFile.type, upsert: false
        }));
      }
      const result = await db.from('sajda_orders').insert({
        id: order.id, items: order.items, customer_name: order.name, phone: order.phone,
        alt_phone: order.altPhone, address: order.address, payer_phone: order.payerPhone,
        proof_path: proofPath, deposit: order.deposit
      });
      if (result.error) {
        if (proofPath) await db.storage.from('order-proofs').remove([proofPath]);
        throw result.error;
      }
    },
    async addReview(review) {
      return checked(requireClient().from('sajda_reviews').insert({
        name: review.name, stars: review.stars, review_text: review.text
      }));
    },
    async addForumPost(post) {
      return checked(requireClient().from('sajda_forum').insert({
        name: post.name, post_text: post.text
      }));
    },
    async addCustomerMessage(message) {
      return checked(requireClient().from('sajda_chats').insert({
        session_id: message.session, customer_name: message.name,
        message: message.text, sender: 'customer'
      }));
    },
    async ensureChatSession(sessionId, name, accessToken) {
        return checked(requireClient().from('sajda_chat_sessions').upsert({
          session_id: sessionId, customer_name: name, access_token: accessToken
        }, { onConflict: 'session_id', ignoreDuplicates: true }));
    },
    async customerMessages(sessionId, accessToken) {
        return checked(requireClient().rpc('read_sajda_chat', {
          p_session_id: sessionId, p_access_token: accessToken
        })).then(rows => rows.map(r => ({
          session: r.session_id, name: r.customer_name, text: r.message,
          from: r.sender, date: r.created_at
        })));
    },
    async lookupInvoice(id) {
        const rows = await checked(requireClient().rpc('lookup_sajda_invoice', { p_order_id: id }));
        return rows[0] || null;
    },
    async signIn(email, password) {
      const db = requireClient();
      const result = await db.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      const member = await db.from('sajda_admins').select('user_id')
        .eq('user_id', result.data.user.id).maybeSingle();
      if (member.error || !member.data) {
        await db.auth.signOut();
        throw member.error || new Error('هذا الحساب غير مخوّل لإدارة المتجر.');
      }
    },
    async signOut() {
      return checked(requireClient().auth.signOut());
    },
    async changePassword(password) {
      const result = await requireClient().auth.updateUser({ password });
      if (result.error) throw result.error;
    },
    async isAdmin() {
      const db = requireClient();
      const { data: { user } } = await db.auth.getUser();
      if (!user) return false;
      const row = await db.from('sajda_admins').select('user_id')
        .eq('user_id', user.id).maybeSingle();
      if (row.error) throw row.error;
      return Boolean(row.data);
    },
    async listAdmin(tab) {
      const db = requireClient();
      const table = {
        products: 'sajda_products', orders: 'sajda_orders', visitors: 'sajda_visitors',
        reviews: 'sajda_reviews', chats: 'sajda_chats', forum: 'sajda_forum',
        promos: 'sajda_promos'
      }[tab];
      if (!table) throw new Error('قسم إدارة غير معروف.');
      const orderColumn = ['sajda_products','sajda_promos'].includes(table)
        ? 'updated_at' : table === 'sajda_visitors' ? 'visited_at' : 'created_at';
      const rows = await checked(db.from(table).select('*').order(orderColumn, {
        ascending: false, nullsFirst: false
      }));
      if (tab === 'products') return rows.map(mapProduct);
      if (tab === 'orders') {
        return Promise.all(rows.map(async r => {
          let proof = '';
          if (r.proof_path) {
            const signed = await db.storage.from('order-proofs').createSignedUrl(r.proof_path, 300);
            if (signed.error) throw signed.error;
            proof = signed.data.signedUrl;
          }
          return {
            id: r.id, items: r.items, name: r.customer_name, phone: r.phone,
            altPhone: r.alt_phone, address: r.address, payerPhone: r.payer_phone,
            proof, date: r.created_at, status: r.status, deposit: Number(r.deposit)
          };
        }));
      }
      if (tab === 'reviews') return rows.map(r => ({
        id: r.id, name: r.name, stars: r.stars, text: r.review_text, date: r.created_at
      }));
      if (tab === 'forum') return rows.map(r => ({
        id: r.id, name: r.name, text: r.post_text, date: r.created_at
      }));
      if (tab === 'chats') return rows.map(r => ({
        id: r.id, session: r.session_id, name: r.customer_name, text: r.message,
        from: r.sender, date: r.created_at
      }));
      if (tab === 'visitors') return rows.map(r => ({
        session: r.session_id, name: r.name, date: r.visited_at
      }));
      return Object.fromEntries(rows.map(r => [r.product_id, { price: Number(r.price) }]));
    },
    async saveProduct(product) {
      const imagePath = await uploadAsset(product.image, 'products');
      const colors = await Promise.all((product.colors || []).map(async color => ({
        name: color.name, image: await uploadAsset(color.image, 'colors')
      })));
      return checked(requireClient().from('sajda_products').upsert({
        id: product.id, name: product.name, category: product.category, price: product.price,
        details: product.details || '', image_path: imagePath, colors, updated_at: new Date().toISOString()
      }));
    },
    async deleteProduct(id) {
      return checked(requireClient().from('sajda_products').delete().eq('id', id));
    },
    async setPromo(id, price) {
      return checked(requireClient().from('sajda_promos').upsert({
        product_id: id, price, updated_at: new Date().toISOString()
      }));
    },
    async deletePromo(id) {
      return checked(requireClient().from('sajda_promos').delete().eq('product_id', id));
    },
    async saveSettings(settings, offers, wheel) {
      const banner = await uploadAsset(settings.banner, 'banners');
      const logo = await uploadAsset(settings.logo, 'logos');
      return checked(requireClient().from('sajda_settings').upsert({
        id: true, title: settings.title, subtitle: settings.subtitle,
        banner_path: banner, logo_path: logo, shipping: offers.shipping,
        deposit: offers.deposit, wheel_enabled: wheel.enabled, wheel_prizes: wheel.prizes
      }, { onConflict: 'id' }));
    },
    async setOrderStatus(id, status) {
      return checked(requireClient().from('sajda_orders').update({ status }).eq('id', id));
    },
    async deleteOrder(id) {
      return checked(requireClient().from('sajda_orders').delete().eq('id', id));
    },
    async deleteReview(id) {
      return checked(requireClient().from('sajda_reviews').delete().eq('id', id));
    },
    async deleteForum(id) {
      return checked(requireClient().from('sajda_forum').delete().eq('id', id));
    },
    async assistantReply(messages) {
      const { data, error } = await requireClient().functions.invoke('sajda-assistant', {
        body: { messages }
      });
      if (error) throw error;
      if (!data || typeof data.reply !== 'string' || !data.reply.trim()) {
        throw new Error('لم يصل رد صالح من مساعد سجدة.');
      }
      return data.reply;
    },
    async replyChat(message) {
      return checked(requireClient().from('sajda_chats').insert({
        session_id: message.session, customer_name: message.name,
        message: message.text, sender: 'admin'
      }));
    }
  };

  window.sajdaBackend = backend;
})();

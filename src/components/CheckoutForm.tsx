import { useState, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { MessageCircle, FileText, CreditCard, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { prefectures } from '@/data/prefectures';
import { CartItem, Order } from '@/types';
import { toast } from '@/hooks/use-toast';
import { useCreateOrder } from '@/hooks/useOrders';
import { useAuth } from '@/hooks/useFirebaseAuth';
import { useShippingRateByPrefecture } from '@/hooks/useShippingRates';
import { useCurrencyConverter } from '@/hooks/useCurrencyConverter';
import { useLanguage } from '@/hooks/useLanguage';
import PaymentMethodInfo from '@/components/PaymentMethodInfo'; 
import { useCODSettings } from '@/hooks/useCODSettings';
import { calculateTotalWithCOD } from '@/services/codSurchargeService';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '@/config/firebase';

const checkoutSchema = z.object({
  fullName: z.string().min(2, 'Nama lengkap harus minimal 2 karakter'),
  whatsapp: z.string().min(10, 'Nomor WhatsApp tidak valid').regex(/^[0-9+\-\s]+$/, 'Format nomor tidak valid'),
  email: z.string().email('Format email tidak valid'),
  prefecture: z.string().min(1, 'Silakan pilih prefektur'),
  city: z.string().min(2, 'Area/Kota/Cho/Machi harus minimal 2 karakter'),
  postalCode: z.string().min(7, 'Kode pos harus 7 digit').max(7, 'Kode pos harus 7 digit').regex(/^[0-9]{7}$/, 'Kode pos harus berupa 7 angka'),
  address: z.string().min(10, 'Alamat lengkap harus minimal 10 karakter'),
  notes: z.string().optional(),
  paymentMethod: z.string().min(1, 'Silakan pilih metode pembayaran'),
});

type CheckoutFormData = z.infer<typeof checkoutSchema>;

interface CheckoutFormProps {
  cart: CartItem[];
  total: number;
  onOrderComplete: () => void;
}
import { ButtonSpinner } from '@/components/ui/loading';

export default function CheckoutForm({ cart, total, onOrderComplete }: CheckoutFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { t } = useLanguage();
  const { user } = useAuth();
  const createOrder = useCreateOrder();
  const [selectedPrefecture, setSelectedPrefecture] = useState<string>('');
  const { data: shippingRate, isLoading: isLoadingShippingRate } = useShippingRateByPrefecture(selectedPrefecture);
  const [shippingFee, setShippingFee] = useState<number | null>(null);
  const [paymentProofFile, setPaymentProofFile] = useState<File | null>(null);
  const [paymentProofPreview, setPaymentProofPreview] = useState<string | null>(null);
  const [showCurrencyInfo, setShowCurrencyInfo] = useState(false);
  const [affiliateId, setAffiliateId] = useState<string | null>(null);
  const [visitorId, setVisitorId] = useState<string | null>(null);
  const { data: codSettings } = useCODSettings();

  // Get affiliate_id only if there's an active referral session
  const form = useForm<CheckoutFormData>({
    resolver: zodResolver(checkoutSchema),
    defaultValues: {
      fullName: '',
      whatsapp: '',
      email: user?.email || '',
      prefecture: '',
      city: '',
      postalCode: '',
      address: '',
      notes: '',
      paymentMethod: '',
    },
  });

  // Get the current payment method
  const paymentMethod = form.watch('paymentMethod');
  
  // Calculate total with shipping and COD surcharge
  const codSurcharge = (paymentMethod === 'COD (Cash on Delivery)' && codSettings?.isEnabled) 
    ? codSettings.surchargeAmount 
    : 0;
  const totalWithShipping = total + (shippingFee || 0) + codSurcharge;

  // Move the currency converter hook to the top level
  const { convertedRupiah, lastUpdated } = useCurrencyConverter(totalWithShipping, paymentMethod);

  // Update shipping fee when prefecture changes
  useEffect(() => {
    if (shippingRate) {
      console.log('Setting shipping fee from rate:', shippingRate);
      setShippingFee(shippingRate.price);
    } else {
      console.log('No shipping rate found, setting fee to null');
      setShippingFee(null);
    }
  }, [shippingRate]);

  // Get affiliate ID from localStorage if not provided
  useEffect(() => {
    // Import referral utilities and check for active session
    import('@/utils/referralUtils').then(({ hasActiveReferralSession, getStoredReferralCode }) => {
      // Only use referral if there's an active session (user came via referral link)
      if (hasActiveReferralSession()) {
        const storedAffiliateId = getStoredReferralCode();
        console.log('Found affiliate ID in localStorage:', storedAffiliateId);
        setAffiliateId(storedAffiliateId);
      } else {
        const storedAffiliateId = getStoredReferralCode();
        if (storedAffiliateId && !hasActiveReferralSession()) {
          console.log('No active referral session - user accessed directly');
          setAffiliateId(null);
        }
      }
    });
    
    // Get or create visitor ID
    let storedVisitorId = localStorage.getItem('visitorId');
    if (!storedVisitorId) {
      storedVisitorId = `visitor_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      localStorage.setItem('visitorId', storedVisitorId);
    }
    setVisitorId(storedVisitorId);
  }, []);

  const generateWhatsAppMessage = (data: CheckoutFormData, convertedRupiahValue?: number) => {
    const productList = cart.map(item => {
      const variants = item.selectedVariants 
        ? Object.entries(item.selectedVariants).map(([type, value]) => `${type}: ${value}`).join(', ') 
        : '';
      
      // Format price based on payment method
      let priceDisplay = `¥${(item.price * item.quantity).toLocaleString()}`;
      
      // Add Rupiah conversion if applicable
      if (convertedRupiahValue && (data.paymentMethod === 'Bank Transfer (Rupiah)' || data.paymentMethod === 'QRIS / QR Code')) {
        const itemRupiah = Math.round((item.price * item.quantity) * (convertedRupiahValue / totalWithShipping));
        priceDisplay = `Rp${itemRupiah.toLocaleString('id-ID')}`;
      }
      
      return `- ${item.name}${variants ? ` | Varian: ${variants}` : ''} | Qty: ${item.quantity} | ${priceDisplay}`;
    }).join('\n');

    const shippingInfo = shippingFee 
      ? `\n*ONGKOS KIRIM:* ${formatCurrencyByMethod(shippingFee, data.paymentMethod, convertedRupiahValue)}` 
      : '';

    // Add affiliate info if available
    const affiliateInfo = affiliateId 
      ? `\n*KODE REFERRAL: ${affiliateId}*`
      : '';

    // Format total based on payment method
    const totalDisplay = formatCurrencyByMethod(totalWithShipping, data.paymentMethod, convertedRupiahValue);

    const message = `Halo Admin Injapan Food

Saya ingin memesan produk melalui website. Berikut detail pesanan saya:

*INFORMASI PENERIMA:*
Nama penerima: ${data.fullName}
Nomor WhatsApp: ${data.whatsapp}
Email: ${data.email}
Prefektur: ${data.prefecture}
Area/Kota/Cho/Machi: ${data.city}
Kode Pos: ${data.postalCode}
Alamat lengkap: ${data.address}

*METODE PEMBAYARAN:*
${data.paymentMethod}

*DAFTAR PRODUK:*
${productList}

*SUBTOTAL BELANJA:* ${formatCurrencyByMethod(total, data.paymentMethod, convertedRupiahValue)}${shippingInfo}
*TOTAL BELANJA:* ${totalDisplay}${affiliateInfo}

${data.notes ? `Catatan: ${data.notes}` : ''}

${paymentProofFile ? 'Saya sudah mengupload bukti pembayaran melalui website.' : ''}

Mohon konfirmasi pesanan saya. Terima kasih banyak!`;

    return encodeURIComponent(message);
  };

  // Helper function to format currency based on payment method
  const formatCurrencyByMethod = (amount: number, method: string, convertedRupiah?: number): string => {
    if ((method === 'Bank Transfer (Rupiah)' || method === 'QRIS / QR Code') && convertedRupiah) {
      // For Rupiah methods, calculate the proportional amount
      const amountInRupiah = Math.round((amount / totalWithShipping) * convertedRupiah);
      return `Rp${amountInRupiah.toLocaleString('id-ID')}`;
    }
    
    // For Yen methods or when conversion is not available
    return `¥${amount.toLocaleString()}`;
  };

  const handlePaymentProofChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!validTypes.includes(file.type)) {
      toast({
        title: "Format file tidak valid",
        description: "Harap unggah file gambar (JPG, PNG, WEBP, GIF)",
        variant: "destructive"
      });
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: "Ukuran file terlalu besar",
        description: "Ukuran file maksimal 5MB",
        variant: "destructive"
      });
      return;
    }

    setPaymentProofFile(file);

    // Create preview
    const reader = new FileReader();
    reader.onload = () => {
      setPaymentProofPreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const removePaymentProof = () => {
    setPaymentProofFile(null);
    setPaymentProofPreview(null);
  };

  const uploadPaymentProof = async (orderId: string): Promise<string | null> => {
    if (!paymentProofFile) return null;

    try {
      // Upload to Firebase Storage
      const storageRef = ref(storage, `payment-proofs/${orderId}_${Date.now()}`);
      await uploadBytes(storageRef, paymentProofFile);
      const downloadURL = await getDownloadURL(storageRef);
      
      return downloadURL;
    } catch (error) {
      console.error('Error uploading payment proof:', error);
      return null;
    }
  };

  const onSubmit = async (data: CheckoutFormData) => {
    if (cart.length === 0) {
      toast({
        title: "Keranjang Kosong",
        description: "Silakan tambahkan produk ke keranjang terlebih dahulu.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);

    try {
      // Create order in Firebase/Firestore
      const orderData = {
        items: cart.map(item => ({
          name: item.name,
          product_id: item.product?.id || item.id.split('-')[0], // Store the product ID for stock updates
          price: item.price,
          quantity: item.quantity,
          image_url: item.image_url,
          selectedVariants: item.selectedVariants || {}
        })),
        totalPrice: totalWithShipping,
        customerInfo: {
          name: data.fullName,
          email: data.email,
          phone: data.whatsapp,
          prefecture: data.prefecture,
          city: data.city,
          postal_code: data.postalCode,
          address: data.address,
          notes: data.notes,
          payment_method: data.paymentMethod
        },
        userId: user?.uid,
        shipping_fee: shippingFee || 0,
        affiliate_id: affiliateId, // Include affiliate ID in order data
        visitor_id: visitorId // Include visitor ID for tracking guest referrals
      };

      console.log('Creating order with affiliate ID:', affiliateId);
      console.log('Creating order with visitor ID:', visitorId);
      
      const orderId = await createOrder.mutateAsync({
        items: orderData.items,
        totalPrice: orderData.totalPrice,
        customerInfo: orderData.customerInfo,
        userId: orderData.userId,
        shipping_fee: orderData.shipping_fee,
        affiliate_id: orderData.affiliate_id,
        visitor_id: orderData.visitor_id
      });

      // Clear referral session after successful order creation
      if (affiliateId) {
        const { clearCurrentSessionReferral } = await import('@/utils/referralUtils');
        clearCurrentSessionReferral();
        console.log('Referral session cleared after order creation');
      }

      // Upload payment proof if provided
      let paymentProofUrl = null;
      if (paymentProofFile) {
        paymentProofUrl = await uploadPaymentProof(orderId);
        
        // If payment proof was uploaded, update the order with the URL
        if (paymentProofUrl) {
          // Import the function here to avoid circular dependencies
          const { updatePaymentProof } = await import('@/services/orderService');
          await updatePaymentProof(orderId, paymentProofUrl);
        }
      }

      // Show success message
      toast({
        title: "Pesanan Berhasil Dibuat",
        description: "Pesanan telah disimpan di riwayat Anda. Silakan lanjutkan ke WhatsApp untuk konfirmasi.",
      });
      
      // Open WhatsApp immediately
      const whatsappMessage = generateWhatsAppMessage(data, convertedRupiah);
      const phoneNumber = '+817084894699'; // Replace with your actual WhatsApp number
      const whatsappUrl = `https://wa.me/${phoneNumber}?text=${whatsappMessage}`;
      window.open(whatsappUrl, '_blank');
      
      // Clear form and cart
      form.reset();
      onOrderComplete();
      
    } catch (error) {
      console.error('Error creating order:', error);
      toast({
        title: "Terjadi Kesalahan",
        description: "Gagal membuat pesanan. Silakan coba lagi.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <h2 className="text-xl font-semibold mb-6 text-gray-800">{t('checkout.shippingInfo')}</h2>
      
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="fullName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('checkout.fullName')} *</FormLabel>
                  <FormControl>
                    <Input placeholder="Masukkan nama lengkap" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="whatsapp"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('checkout.whatsapp')} *</FormLabel>
                  <FormControl>
                    <Input placeholder="081234567890" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('checkout.email')} *</FormLabel>
                <FormControl>
                  <Input type="email" placeholder="contoh@email.com" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="prefecture"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('checkout.prefecture')} *</FormLabel>
                  <Select 
                    onValueChange={(value) => {
                      field.onChange(value);
                      console.log('Selected prefecture:', value);
                      setSelectedPrefecture(value.toLowerCase());
                    }} 
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger className="bg-white">
                      <SelectValue placeholder={t('checkout.selectPrefecture')} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="bg-white border shadow-lg max-h-60 z-50">
                      {prefectures.map((prefecture) => (
                        <SelectItem key={prefecture.name} value={prefecture.name_en.toLowerCase()}>
                          {prefecture.name} ({prefecture.name_en})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="city"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('checkout.city')} *</FormLabel>
                  <FormControl>
                    <Input placeholder="Contoh: Shibuya-ku, Harajuku" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="postalCode"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('checkout.postalCode')} *</FormLabel>
                <FormControl>
                  <Input placeholder="1234567" maxLength={7} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="address"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('checkout.address')} *</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Masukkan alamat lengkap termasuk nomor rumah, nama jalan, dll."
                    rows={3}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('checkout.notes')}</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Tambahkan catatan khusus untuk pesanan Anda..."
                    rows={2}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Payment Method Selection */}
          <FormField
            control={form.control}
            name="paymentMethod"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('checkout.paymentMethod')} *</FormLabel>
                <Select 
                  onValueChange={field.onChange} 
                  defaultValue={field.value}
                >
                  <FormControl>
                    <SelectTrigger className="bg-white">
                      <SelectValue placeholder="Pilih metode pembayaran" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent className="bg-white border shadow-lg z-50">
                    <SelectItem value="COD (Cash on Delivery)">{t('checkout.cod')}</SelectItem>
                    <SelectItem value="Bank Transfer (Rupiah)">{t('checkout.bankTransferRupiah')}</SelectItem>
                    <SelectItem value="Bank Transfer (Yucho / ゆうちょ銀行)">{t('checkout.bankTransferYucho')}</SelectItem>
                    <SelectItem value="QRIS / QR Code">{t('checkout.qris')}</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Payment Method Info */}
          {paymentMethod && (
            <PaymentMethodInfo 
              paymentMethod={paymentMethod} 
              totalAmount={totalWithShipping} 
            />
          )}

          {/* Payment Proof Upload (Optional) */}
          {paymentMethod && paymentMethod !== 'COD (Cash on Delivery)' && (
            <div className="space-y-2">
              <FormLabel>{t('checkout.paymentProof')}</FormLabel>
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-4">
                <Input
                  type="file"
                  accept="image/*"
                  onChange={handlePaymentProofChange}
                  className="mb-2"
                />
                <p className="text-xs text-gray-500">
                  {t('checkout.paymentProofFormats')}
                </p>
                
                {paymentProofPreview && (
                  <div className="mt-3">
                    <div className="relative inline-block">
                      <img 
                        src={paymentProofPreview} 
                        alt="Preview" 
                        className="w-40 h-40 object-contain rounded-md border border-gray-200" 
                      />
                      <button
                        type="button"
                        onClick={removePaymentProof}
                        className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs hover:bg-red-600"
                      >
                        ✕
                      </button>
                    </div>
                    <p className="text-sm text-green-600 mt-2">
                      {t('checkout.paymentProofReady')}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Affiliate Info (if available) */}
          {affiliateId && (
            <div className="bg-blue-50 p-4 rounded-lg border border-blue-100">
              <h4 className="font-medium text-blue-800 mb-2">Informasi Referral:</h4>
              <p className="text-sm text-blue-700">
                Anda menggunakan kode referral: <span className="font-mono font-bold">{affiliateId}</span>
              </p>
            </div>
          )}

          {/* Order Summary with Shipping Fee */}
          <div className="border-t border-b py-4 my-4 space-y-2">
            <div className="flex justify-between items-center">
              <span className="font-medium">{t('checkout.productSubtotal')}</span>
              <span>¥{total.toLocaleString()}</span>
            </div>
            
            <div className="flex justify-between items-center">
              <span className="font-medium">{t('checkout.shippingCost')}</span>
              {selectedPrefecture ? (
                isLoadingShippingRate ? (
                  <span className="text-gray-500">{t('checkout.loading')}</span>
                ) : shippingFee !== null ? (
                  <span>¥{shippingFee.toLocaleString()}</span>
                ) : (
                  <span className="text-yellow-600 text-sm">{t('checkout.shippingNotSet')}</span>
                )
              ) : (
                <span className="text-gray-500">{t('checkout.selectPrefecture')}</span>
              )}
            </div>
            
            {/* COD Surcharge */}
            {paymentMethod === 'COD (Cash on Delivery)' && codSettings?.isEnabled && codSurcharge > 0 && (
              <div className="flex justify-between items-center text-orange-600">
                <span className="font-medium">Biaya Tambahan COD:</span>
                <span>¥{codSurcharge.toLocaleString()}</span>
              </div>
            )}
            
            <div className="flex justify-between items-center pt-2 mt-2 text-lg font-bold">
              <span>{t('cart.total')}</span>
              <span className="text-primary">¥{totalWithShipping.toLocaleString()}</span>
            </div>
          </div>

          <div className="pt-4 border-t">
            <Button
              type="submit"
              disabled={isSubmitting || cart.length === 0 || (selectedPrefecture && shippingFee === null)}
              className="w-full bg-green-600 hover:bg-green-700 text-white py-3 text-lg font-semibold flex items-center justify-center space-x-2"
            >
              {isSubmitting && <ButtonSpinner />}
              <MessageCircle className="w-5 h-5" />
              <span>
                {isSubmitting ? t('checkout.processing') : t('checkout.orderViaWhatsApp')}
              </span>
            </Button>
            <p className="text-center text-sm text-gray-600 mt-2">{t('checkout.orderSaved')}</p>
            
            {selectedPrefecture && shippingFee === null && (
              <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                <p className="text-sm text-yellow-700">
                  {t('checkout.shippingNotConfigured')}
                </p>
              </div>
            )}
            
            {/* COD Information */}
            {paymentMethod === 'COD (Cash on Delivery)' && codSettings?.isEnabled && codSurcharge > 0 && (
              <div className="mt-4 p-3 bg-orange-50 border border-orange-200 rounded-lg">
                <p className="text-sm text-orange-700">
                  <strong>Informasi COD:</strong> Biaya tambahan ¥{codSurcharge.toLocaleString()} akan dikenakan untuk pembayaran COD.
                </p>
              </div>
            )}
          </div>
        </form>
      </Form>
    </div>
  );
}